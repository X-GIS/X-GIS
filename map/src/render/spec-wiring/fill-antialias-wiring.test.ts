// fill-antialias opt-out wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: fill-antialias=false is
// implemented end-to-end (compiler emits the `fill-antialias-false` flag →
// ShowCommand.fillAntialias=false; runtime gates the rim smoothstep off), but
// the ONLY tests were the compiler-side conversion smoke (fill-antialias-warn)
// and the WGSL-compile smoke — neither would catch a BROKEN RUNTIME DATA PATH
// where the baked flag stops being threaded into the GPU uniform.
//
// The runtime contract (VectorTileRenderer): the per-frame baked field
// `currentFillAntialias` (1 = default/on, 0 = the fill-antialias=false opt-out)
// is packed into the polygon uniform's spare cam_ecef_off_h.w lane = f32 slot
// 55, which the polygon fragment shader reads via `!= 0` to gate the sphere-rim
// smoothstep AA fade. `currentFillAntialias` itself is derived in render() from
// `show.fillAntialias === false ? 0 : 1` (vector-tile-renderer.ts ~2320).
//
// Harness (mirrors pattern-uv-clobber.test.ts): drive the REAL renderTileKeys
// over one minimal cached tile (all geometry counts 0 → no GPU draw is emitted;
// the per-tile loop still runs the DSFUN uniform pack + stageUniformSlot) and
// read the bytes staged into the uniform ring — that is the ground truth that
// reaches the GPU. We set `currentFillAntialias` (the per-frame baked field,
// the same tier of renderer state the pattern-uv harness sets directly:
// cachedFillColor / _patternUniformActive) and assert slot 55 carries it.
//
// Fail-before: replace `this.uniformF32[55] = this.currentFillAntialias` with a
// constant (`= 1`) in vector-tile-renderer.ts and the false-case assertion
// (slot 55 === 0) fails — the wire that makes fill-antialias=false actually
// reach the GPU is gone, and the test catches it before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveShow } from '../resolved-show'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { initGPU } from '@xgis/rhi-webgpu'
import { VectorTileRenderer } from '@xgis/map'
import { UniformRing } from '@xgis/map'
import { polygonUniformStride } from '@xgis/map'

// cam_ecef_off_h.w — the spare lane fill-antialias rides (1 default, 0 = off).
const FILL_ANTIALIAS_SLOT = 55

let stub: StubInstallation
let stubCtx: Awaited<ReturnType<typeof initGPU>>

beforeEach(async () => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
  stubCtx = await makeCtx()
})
afterEach(() => {
  stub.uninstall()
})

async function makeCtx(): Promise<Awaited<ReturnType<typeof initGPU>>> {
  const canvas = { width: 1024, height: 720 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas)
}

/** A UniformRing backed by a write-recording fake device (mirrors
 *  uniform-ring.test.ts / pattern-uv-clobber.test.ts). The staged bytes are
 *  read back via the private `staging` Uint8Array — exactly what flush()
 *  uploads to the GPU. */
function makeRecordingRing(): { ring: UniformRing; staging: () => Float32Array } {
  // Stride derived from reflect() (lazy: safe here, after configureProjections).
  const UNIFORM_SLOT = polygonUniformStride()
  // RHI-shaped stub (#832 M2) — the ring creates/writes through RhiDevice now.
  const device = {
    createBuffer: () => ({}),
    writeBuffer: () => {},
    destroyBuffer: () => {},
  } as unknown as import('@xgis/engine').RhiDevice
  const ring = new UniformRing(device, UNIFORM_SLOT, 8, 'test-ring', () => {})
  ring.ensure()
  const staging = () => {
    const u8 = (ring as unknown as { staging: Uint8Array }).staging
    // f32 view over slot 0 (the only slot this single-tile render allocates).
    return new Float32Array(u8.buffer, u8.byteOffset, UNIFORM_SLOT / 4)
  }
  return { ring, staging }
}

/** Minimal GPUTile stub: every geometry count is 0 so the per-tile loop
 *  reaches stageUniformSlot WITHOUT emitting any drawIndexed / drawSegments. */
function stubTile() {
  return {
    lastUsedFrame: 0,
    tileWest: 0,
    tileSouth: 0,
    tileZoom: 4,
    indexCount: 0,
    lineIndexCount: 0,
    outlineSegmentCount: 0,
    lineSegmentCount: 0,
    dequantScale: 1,
    dequantHalf: 0,
    extruded: false,
    featureBindGroup: null,
  } as unknown as import('@xgis/map').GPUTile
}

/** Drive renderTileKeys for one tile with `currentFillAntialias` baked to the
 *  given value (1 = default/on, 0 = the fill-antialias=false opt-out), then
 *  return the staged uniform floats. */
function stageOneTile(antialiasFlag: number): Float32Array {
  const ctx = stubCtx
  const vtr = new VectorTileRenderer(ctx) as unknown as Record<string, unknown>

  // Inject the recording ring (bypass the GPU-bound _onUniformRingGrow path).
  const { ring, staging } = makeRecordingRing()
  vtr.uniformRing = ring

  // Make baseLayout()/baseGroup() return matching non-null sentinels so the
  // fillBg / currentTileBg resolution inside renderTileKeys passes (uniform-only
  // base path — no per-tile feature group needed).
  const layoutSentinel = { __layout: true } as unknown as GPUBindGroupLayout
  const groupSentinel = { __group: true } as unknown as GPUBindGroup
  const reg = vtr._bindGroups as Record<string, unknown>
  reg.baseBindGroupLayout = layoutSentinel
  reg.tileBgDefault = groupSentinel

  // Resolved fill/stroke state (so the per-tile alpha pack runs cleanly).
  vtr.cachedFillColor = [0.5, 0.5, 0.5, 1]
  vtr.cachedStrokeColor = [0.5, 0.5, 0.5, 1]
  vtr.currentOpacity = 1
  vtr._skipFillDraw = false
  vtr._patternUniformActive = false
  vtr._linePatternActiveForShow = false

  // The per-frame baked fill-antialias flag — what render() derives from
  // `show.fillAntialias === false ? 0 : 1`. The DSFUN pack threads this into
  // uniform slot 55; this test pins that thread.
  vtr.currentFillAntialias = antialiasFlag

  const layerCache = new Map<number, unknown>()
  const KEY = 12345
  layerCache.set(KEY, stubTile())

  const passStub = {} as unknown as GPURenderPassEncoder

  // private renderTileKeys(keys, pass, fillPipeline, linePipeline, projLon,
  //   projLat, worldOffsets, lineLayerOffset, lineLayerOffsetGap, phase,
  //   layerCache, fillPipelineExtruded, fillBindGroupLayout, translucentBucket?)
  ;(vtr.renderTileKeys as (...a: unknown[]) => void).call(
    vtr,
    [KEY], // keys
    passStub, // pass
    {} as GPURenderPipeline, // fillPipeline (never used: indexCount 0)
    {} as GPURenderPipeline, // linePipeline
    0, // projCenterLon
    0, // projCenterLat
    undefined, // worldOffsets
    0, // lineLayerOffset
    -1, // lineLayerOffsetGap (single-line sentinel)
    'fills', // phase (drawStrokes=false → no stroke path)
    layerCache, // layerCache
    null, // fillPipelineExtruded
    layoutSentinel, // fillBindGroupLayout (=== baseLayout())
  )

  return staging()
}

describe('fill-antialias opt-out wiring (uf[55] = currentFillAntialias)', () => {
  it('default (fill-antialias on) → slot 55 carries 1', () => {
    const staged = stageOneTile(1)
    expect(staged[FILL_ANTIALIAS_SLOT]).toBe(1)
  })

  it('fill-antialias=false opt-out → slot 55 carries 0', () => {
    // Break `uf[55] = this.currentFillAntialias` to a constant and this fails —
    // the opt-out flag no longer reaches the GPU.
    const staged = stageOneTile(0)
    expect(staged[FILL_ANTIALIAS_SLOT]).toBe(0)
  })

  it('slot 55 is prop-controlled, not a constant (on vs off differ)', () => {
    const on = stageOneTile(1)[FILL_ANTIALIAS_SLOT]
    const off = stageOneTile(0)[FILL_ANTIALIAS_SLOT]
    expect(on).not.toBe(off)
  })
})

// ─── #1995: the ZOOM-expression form reaches the same lane ───────────────────
//
// OFM Bright's `landcover-wood` authors `["step", ["zoom"], false, 9, true]`.
// That lowers to the 0/1 zoom shape below on ShowCommand.fillAntialias, and
// render() bakes `currentFillAntialias` from the PER-FRAME ResolvedShow rather
// than the raw ShowCommand — so the flag now varies with camera zoom.
//
// This drives the REAL resolveShow (no re-implemented curve here: the shape
// below is the compiler's output, pinned by
// compiler/src/__tests__/fill-antialias-expr.test.ts) and stages the resolved
// flag through the REAL renderTileKeys, asserting the lane flips at z9.
//
// Scope note (honest): the hop this GPU-free harness cannot execute is
// render()'s own `currentFillAntialias = resolvedShow.fillAntialias ? 1 : 0`
// statement — render() needs an attached tile source before it reaches that
// line. Its two halves are each pinned: the resolve by
// resolved-show.test.ts's "flips exactly at the authored zoom 9", the lane
// write by the three cases above. Nor does any of this reach the WebGL2 arm,
// which has its own pack and never runs that statement — see the #1999 block
// at the bottom of this file.
const OFM_LANDCOVER_WOOD_AA = {
  kind: 'zoom-interpolated',
  stops: [
    { zoom: 8.9999, value: 0 },
    { zoom: 9, value: 1 },
  ],
}

/** ShowCommand-shaped stub carrying only what resolveShow reads. */
function showWithAntialias(fillAntialias: unknown): never {
  return {
    targetName: 'src',
    layerName: 'landcover-wood',
    paintShapes: {
      fill: { fill: null },
      line: { stroke: null, strokeWidth: { kind: 'constant', value: 1 } },
      circle: { size: null },
      common: { opacity: { kind: 'constant', value: 1 } },
    },
    fillAntialias,
  } as never
}

/** slot 55 for one frame at `zoom`, with the flag taken from the REAL
 *  per-frame resolve of `fillAntialias` (mirrors render()'s bake). */
function laneAtZoom(fillAntialias: unknown, zoom: number): number {
  const resolved = resolveShow(showWithAntialias(fillAntialias), {
    cameraZoom: zoom,
    elapsedMs: 0,
  })
  return stageOneTile(resolved.fillAntialias ? 1 : 0)[FILL_ANTIALIAS_SLOT]!
}

describe('fill-antialias zoom expression → the same uniform lane (#1995)', () => {
  it('the OFM Bright step reaches slot 55 as 0 below z9 and 1 from z9 up', () => {
    // Fail-before (pre-#1995): the zoom form never reached ShowCommand at all
    // — the converter dropped it with a warning — so both zooms staged 1.
    expect(laneAtZoom(OFM_LANDCOVER_WOOD_AA, 8.5)).toBe(0)
    expect(laneAtZoom(OFM_LANDCOVER_WOOD_AA, 9)).toBe(1)
  })

  it('the constant forms still stage what they always did', () => {
    expect(laneAtZoom(false, 9)).toBe(0)
    expect(laneAtZoom(true, 9)).toBe(1)
    expect(laneAtZoom(undefined, 9)).toBe(1)
  })
})

// ─── #1999: the WebGL2 arm packs the same lane, and used to hardcode it ──────
//
// Everything above drives `renderTileKeys`, and EVERY call site of that method
// is inside `render()` — so none of it can witness the WebGL2 arm. That arm is
// `renderFillsRhi`, a twin with its OWN `cam_ecef_off_h` pack, and it used to
// write the .w lane as the literal `1` with a comment saying "antialias on".
// The result: `fill-antialias: false` was inert on WebGL2, and the sibling
// field `currentFillAntialias` was never even read there, so the fix #1999's
// body proposed (assigning the field somewhere in the immediate arm) would have
// changed nothing on screen while passing any field-level assertion.
//
// A SOURCE gate, for the reason paintless-show-acquires.test.ts states about
// this exact method: `renderFillsRhi` needs a real device, source, layer cache
// and camera, and a stub deep enough to execute it would pin the mock rather
// than the code. So the property is asserted about the twin's TEXT — that it
// derives the lane and packs what it derived, in that order.
const VTR_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'vector-tile-renderer.ts'),
  'utf8',
)

/** The `renderFillsRhi` body, from its signature to the next method. */
function fillsRhiBody(): string {
  const at = VTR_SRC.indexOf('  renderFillsRhi(')
  expect(at, 'renderFillsRhi still exists').toBeGreaterThan(-1)
  const end = VTR_SRC.indexOf('\n  renderLinesRhi(', at)
  expect(end, 'renderLinesRhi still follows it').toBeGreaterThan(at)
  return VTR_SRC.slice(at, end)
}

describe('the WebGL2 fills arm packs the resolved antialias lane (#1999)', () => {
  const body = fillsRhiBody()
  const iDerive = body.indexOf('this.currentFillAntialias = resolvedShow.fillAntialias')
  const iPack = body.indexOf('B.set.cam_ecef_off_h(')

  it('derives the lane from the PER-FRAME resolved show', () => {
    // Fail-before: delete the assignment and this is -1. render()'s own
    // assignment cannot stand in — it sits below the immediate-arm early
    // return, so it is unreachable on this backend.
    expect(
      iDerive,
      'renderFillsRhi must assign currentFillAntialias from resolvedShow.fillAntialias',
    ).toBeGreaterThan(-1)
  })

  it('packs what it derived, not a literal', () => {
    expect(iPack, 'renderFillsRhi still packs cam_ecef_off_h').toBeGreaterThan(-1)
    const call = body.slice(iPack, body.indexOf(')', body.indexOf('ecefZH', iPack)) + 1)
    // Fail-before: restore the pre-#1999 `..., anchor.ecefZH, 1)` and this fails
    // naming the arm — the lane would carry 1 for every show again.
    expect(
      call.includes('this.currentFillAntialias'),
      `the WebGL2 fills arm must pack currentFillAntialias into cam_ecef_off_h.w, not a constant — got: ${call.replace(/\s+/g, ' ')}`,
    ).toBe(true)
  })

  it('derives BEFORE it packs (a later assignment would pack the prior frame)', () => {
    expect(iDerive, 'the assignment must precede the pack').toBeLessThan(iPack)
  })
})
