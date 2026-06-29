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
import { installWebGPUStub, type StubInstallation } from '../../../__test-support__/webgpu-stub'
import { initGPU } from '../../gpu/gpu'
import { VectorTileRenderer } from '../vector-tile-renderer'
import { UniformRing } from '../uniform-ring'
import { polygonUniformStride } from '../polygon-uniform-slots'

// cam_ecef_off_h.w — the spare lane fill-antialias rides (1 default, 0 = off).
const FILL_ANTIALIAS_SLOT = 55

let stub: StubInstallation
let stubCtx: Awaited<ReturnType<typeof initGPU>>

beforeEach(async () => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800; height = 600
      getContext(_t: string): unknown { return null }
    } as never
  }
  stub = installWebGPUStub()
  stubCtx = await makeCtx()
})
afterEach(() => { stub.uninstall() })

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
  const device = {
    createBuffer: () => ({ destroy() {} } as unknown as GPUBuffer),
    queue: { writeBuffer: () => {} },
  } as unknown as GPUDevice
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
    tileWest: 0, tileSouth: 0, tileZoom: 4,
    indexCount: 0, lineIndexCount: 0,
    outlineSegmentCount: 0, lineSegmentCount: 0,
    dequantScale: 1, dequantHalf: 0,
    extruded: false,
    featureBindGroup: null,
  } as unknown as import('../vector-tile-renderer-types').GPUTile
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
    [KEY],                 // keys
    passStub,              // pass
    {} as GPURenderPipeline, // fillPipeline (never used: indexCount 0)
    {} as GPURenderPipeline, // linePipeline
    0,                     // projCenterLon
    0,                     // projCenterLat
    undefined,             // worldOffsets
    0,                     // lineLayerOffset
    -1,                    // lineLayerOffsetGap (single-line sentinel)
    'fills',               // phase (drawStrokes=false → no stroke path)
    layerCache,            // layerCache
    null,                  // fillPipelineExtruded
    layoutSentinel,        // fillBindGroupLayout (=== baseLayout())
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
