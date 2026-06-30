// fill-color data-path wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: paint `fill-color`
// (Mapbox/xgis) is marked `supported` and rests on STRUCTURAL/compile tests,
// so a broken render-wire would ship silently (the heatmap-class bug). The
// runtime contract for the polygon fill: the resolved fill-color is cached in
// VectorTileRenderer.cachedFillColor (RGBA), and the per-tile loop in
// renderTileKeys derives the GPU-visible fill alpha as
//   baseFillA = cachedFillColor[3] * currentOpacity   (vector-tile-renderer.ts:3641)
// and writes it into the staged uniform's fill_color.a slot (uf[19], :3649),
// which is then uploaded to the GPU (:3892). The polygon fragment shader reads
// fill_color.a as the fill opacity.
//
// NOTE: the fill-color RGB (uf[16..18]) is assigned in render() (:2393) and
// merely PASSES THROUGH renderTileKeys untouched; only the ALPHA component is
// re-derived from cachedFillColor inside the directly-drivable renderTileKeys.
// So the alpha is the fill-color wire reachable without a full GPU render() —
// and it is non-vacuous: the asserted value TRACKS the prop (0.73 at opacity 1,
// 0.365 at opacity 0.5), never a constant.
//
// Harness: mirrors pattern-uv-clobber.test.ts — drive the REAL renderTileKeys
// over one minimal cached tile (all geometry counts 0 → no GPU draw is emitted;
// the per-tile loop still runs the uniform pack + stageUniformSlot + flush) and
// read the bytes staged into the uniform ring (the ground truth that reaches
// the GPU).
//
// Fail-before: replace `const baseFillA = this.cachedFillColor[3] * (this.currentOpacity ?? 1.0)`
// with `const baseFillA = 0` (or any constant) and the slot-19 assertions fail
// — the fill-color alpha wire is gone, and the test says so before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU } from '@xgis/engine'
import { VectorTileRenderer } from './vector-tile-renderer'
import { UniformRing } from './uniform-ring'
import { polygonUniformStride } from './polygon-uniform-slots'

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
 *  pattern-uv-clobber.test.ts). The staged bytes are read back via the private
 *  `staging` Uint8Array — that is exactly what flush() uploads to the GPU. */
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
  } as unknown as import('./vector-tile-renderer-types').GPUTile
}

/** Drive renderTileKeys for one tile with a resolved fill-color (RGBA) +
 *  opacity, then return the staged uniform floats. fill_color.a (uf[19]) is
 *  derived as cachedFillColor[3] * currentOpacity by the per-tile loop. */
function stageOneTile(opts: {
  fillRgba: [number, number, number, number]
  opacity: number
}): Float32Array {
  const ctx = stubCtx
  const vtr = new VectorTileRenderer(ctx) as unknown as Record<string, unknown>

  // Inject the recording ring (bypass the GPU-bound _onUniformRingGrow path).
  const { ring, staging } = makeRecordingRing()
  vtr.uniformRing = ring

  // Make baseLayout()/baseGroup() resolve to matching non-null sentinels so the
  // fillBg / currentTileBg resolution inside renderTileKeys passes (the
  // uniform-only base path — no per-tile feature group needed).
  const layoutSentinel = { __layout: true } as unknown as GPUBindGroupLayout
  const groupSentinel = { __group: true } as unknown as GPUBindGroup
  const reg = vtr._bindGroups as Record<string, unknown>
  reg.baseBindGroupLayout = layoutSentinel
  reg.tileBgDefault = groupSentinel

  // Resolved fill-color + opacity state. NON-pattern path so the per-tile loop
  // writes baseFillA = cachedFillColor[3] * currentOpacity into uf[19].
  vtr.cachedFillColor = [opts.fillRgba[0], opts.fillRgba[1], opts.fillRgba[2], opts.fillRgba[3]]
  vtr.cachedStrokeColor = [0.5, 0.5, 0.5, 1]
  vtr.currentOpacity = opts.opacity
  vtr._skipFillDraw = false
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

describe('fill-color data-path wiring (GPU-free)', () => {
  // A distinct fill alpha (0.73) that is NOT equal to opacity → the assertion
  // can only pass if the wire reads cachedFillColor[3] (non-vacuous).
  const FILL: [number, number, number, number] = [0.2, 0.4, 0.6, 0.73]

  it('staged fill_color.a (uf[19]) carries the resolved fill-color alpha', () => {
    const staged = stageOneTile({ fillRgba: FILL, opacity: 1 })
    // Break `baseFillA = cachedFillColor[3] * opacity` → 0 / constant → this fails.
    expect(staged[19]).toBeCloseTo(0.73, 6)
  })

  it('fill_color.a tracks fill-color alpha × layer opacity (proves it is not a constant)', () => {
    const staged = stageOneTile({ fillRgba: FILL, opacity: 0.5 })
    // 0.73 * 0.5 = 0.365 — distinct from both the alpha (0.73) and any constant.
    expect(staged[19]).toBeCloseTo(0.365, 6)
  })
})
