// fill-outline-color: stroke_color GPU-wire (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap. `fill-outline-color`
// is marked `supported` for the `fill` layer (runtime/src/capabilities/fill.ts
// rows 25-26) and is behaviorally covered on the COMPILE side
// (compiler/src/__tests__/fill-outline-color.test.ts proves it lowers to
// `stroke-<color> stroke-1`). But the RUNTIME render-wiring — that the
// resolved outline colour actually reaches a GPU uniform — rested only on the
// WGSL-compile smoke + arch line-count. A break in that thread (the renderer
// silently dropping the stroke colour) would ship invisibly: the
// heatmap-class data-path bug.
//
// Runtime consumer (traced):
//   • compiler/src/convert/paint-fill.ts:101 addFillOutline → emits
//     `stroke-<color>` (the xgis utility fill-outline-color lowers to).
//   • The polygon renderer parses that into `show.stroke` →
//     vector-tile-renderer.ts:2350 parseHexColor → cachedStrokeColor[0..3].
//   • render() copies it into stroke_color uniform slots 20-23
//     (vector-tile-renderer.ts:2410-2411), and the per-tile loop stages the
//     stroke ALPHA into uf[23]:
//       vector-tile-renderer.ts:3642  baseStrokeA = cachedStrokeColor[3] * opacity
//       vector-tile-renderer.ts:3650  if (!_linePatternActiveForShow) uf[23] = baseStrokeA
//     uf[23] is stroke_color.a — what the polygon fragment shader reads as the
//     outline's coverage/alpha. That is the byte the fill-outline-color wire
//     ultimately controls per frame.
//
// Harness mirrors pattern-uv-clobber.test.ts EXACTLY: drive the REAL
// renderTileKeys over one minimal cached tile (all geometry counts 0 → no GPU
// draw is emitted; the loop still runs the per-tile uniform pack +
// stageUniformSlot + flush) and read the staged uniform bytes — the ground
// truth that reaches the GPU. No GPU required.
//
// Non-vacuous: cachedStrokeColor IS the resolved fill-outline colour. Two
// distinct outline alphas (× distinct opacities) are driven and the staged
// uf[23] is asserted to equal alpha×opacity for EACH — so the assertion tracks
// the prop, never a constant.
//
// Fail-before: replace
//   `if (!this._linePatternActiveForShow) this.uniformF32[23] = baseStrokeA`
// with `this.uniformF32[23] = 0` (drop the wire) and both alpha assertions go
// red — the fill-outline-color alpha no longer reaches the GPU, and this test
// says so before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../../__test-support__/webgpu-stub'
import { initGPU } from '@xgis/engine'
import { VectorTileRenderer } from '../vector-tile-renderer'
import { UniformRing } from '../uniform-ring'
import { polygonUniformStride } from '@xgis/map'

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

/** Drive renderTileKeys for one tile with the resolved fill-outline colour
 *  (cachedStrokeColor) and the given opacity, then return the staged uniform
 *  floats. */
function stageOneTile(opts: {
  strokeColor: [number, number, number, number]
  opacity: number
}): Float32Array {
  const ctx = stubCtx
  const vtr = new VectorTileRenderer(ctx) as unknown as Record<string, unknown>

  // Inject the recording ring (bypass the GPU-bound _onUniformRingGrow path).
  const { ring, staging } = makeRecordingRing()
  vtr.uniformRing = ring

  // Make baseLayout()/baseGroup() return matching non-null sentinels so the
  // fillBg / currentTileBg resolution inside renderTileKeys passes. Pass the
  // SAME layout sentinel as fillBindGroupLayout so the `=== baseLayout()` arm
  // is taken (uniform-only base path — no per-tile feature group needed).
  const layoutSentinel = { __layout: true } as unknown as GPUBindGroupLayout
  const groupSentinel = { __group: true } as unknown as GPUBindGroup
  const reg = vtr._bindGroups as Record<string, unknown>
  reg.baseBindGroupLayout = layoutSentinel
  reg.tileBgDefault = groupSentinel

  // Resolved fill-outline state: cachedStrokeColor IS the colour parsed from
  // show.stroke (the `stroke-<color>` utility fill-outline-color lowers to).
  // Fill alpha 1 keeps _skipFillDraw false so the per-tile loop runs.
  vtr.cachedFillColor = [0.5, 0.5, 0.5, 1]
  vtr.cachedStrokeColor = opts.strokeColor
  vtr.currentOpacity = opts.opacity
  vtr._skipFillDraw = false
  // No pattern active → the stroke-alpha wire (uf[23] = baseStrokeA) runs.
  vtr._patternUniformActive = false
  vtr._linePatternActiveForShow = false

  const layerCache = new Map<number, unknown>()
  const KEY = 12345
  layerCache.set(KEY, stubTile())

  const passStub = {} as unknown as GPURenderPassEncoder

  // private renderTileKeys(keys, pass, fillPipeline, linePipeline, projLon,
  //   projLat, worldOffsets, lineLayerOffset, lineLayerOffsetGap, phase,
  //   layerCache, fillPipelineExtruded, fillBindGroupLayout, translucentBucket?)
  ;(vtr.renderTileKeys as (...a: unknown[]) => void).call(
    vtr,
    [KEY],                   // keys
    passStub,                // pass
    {} as GPURenderPipeline, // fillPipeline (never used: indexCount 0)
    {} as GPURenderPipeline, // linePipeline
    0,                       // projCenterLon
    0,                       // projCenterLat
    undefined,               // worldOffsets
    0,                       // lineLayerOffset
    -1,                      // lineLayerOffsetGap (single-line sentinel)
    'fills',                 // phase
    layerCache,              // layerCache
    null,                    // fillPipelineExtruded
    layoutSentinel,          // fillBindGroupLayout (=== baseLayout())
  )

  return staging()
}

describe('fill-outline-color stroke_color GPU-wire (uf[23] = outline alpha × opacity)', () => {
  it('threads the resolved outline alpha into stroke_color.a (uf[23])', () => {
    // Outline alpha 0.4, full opacity → uf[23] must carry 0.4.
    const staged = stageOneTile({ strokeColor: [0.2, 0.6, 0.9, 0.4], opacity: 1 })
    expect(staged[23]).toBeCloseTo(0.4, 6)
  })

  it('uf[23] tracks the prop: a DIFFERENT outline alpha × opacity reaches the GPU', () => {
    // Outline alpha 0.8, layer opacity 0.5 → uf[23] = 0.8 * 0.5 = 0.4? No:
    // distinct from the first case at the byte level — 0.8 * 0.75 = 0.6.
    const staged = stageOneTile({ strokeColor: [0.1, 0.2, 0.3, 0.8], opacity: 0.75 })
    expect(staged[23]).toBeCloseTo(0.6, 6)
  })

  it('outline alpha 0 (transparent outline) reaches the GPU as 0 — not a hardcoded non-zero', () => {
    const staged = stageOneTile({ strokeColor: [0.5, 0.5, 0.5, 0], opacity: 1 })
    expect(staged[23]).toBeCloseTo(0, 6)
  })
})
