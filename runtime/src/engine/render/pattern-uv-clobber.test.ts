// Fail-before gate for the fill/line-pattern atlas-UV clobber (the fill_color /
// stroke_color alpha lanes) in VectorTileRenderer.renderTileKeys.
//
// When a fill/line PATTERN is active, render() packs the sprite-atlas UV bbox
// into the fill_color slot (v1 = fill_color.a) and the stroke_color slot
// (v1 = stroke_color.a). The fragment shader (map/src/shaders/dsl/polygon
// fs_fill_pattern) reads fill_color.a / stroke_color.a as the pattern's v1.
//
// The per-tile loop in renderTileKeys UNCONDITIONALLY overwrote those two
// lanes with the resolved fill/stroke ALPHA (baseFillA / baseStrokeA), so the
// staged uniform that reaches the GPU carried alpha (e.g. 1.0) where the
// shader expected v1 (e.g. 0.4) → corrupt pattern UV (black / garbage). Fix:
// guard the fill_color write by _patternUniformActive and the stroke_color
// write by _linePatternActiveForShow (the line-pattern flag).
//
// #733 REWRITE: the packer surface this pins moved from the hand-indexed
// `uniformF32` array (uf[16..23]) to the typed UniformBlock (`frameBlock.set.
// fill_color/stroke_color`); the test drives the same real renderTileKeys and
// reads the same staged ring bytes, but writes through the block and derives
// the lane indices from polygonUniformSlots() (reflect) instead of magic 16/23.
//
// Harness: drive the REAL renderTileKeys over one minimal cached tile (all
// geometry counts 0 → no GPU draw is emitted; the loop still runs the per-tile
// uniform pack + stageUniformSlot + flush) and read the bytes that were staged
// into the uniform ring. This is the ground truth that reaches the GPU.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU } from '@xgis/engine'
import { VectorTileRenderer } from '@xgis/map'
import { UniformRing } from '@xgis/map'
import { polygonUniformStride, polygonUniformSlots } from '@xgis/map'

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
 *  uniform-ring.test.ts). The staged bytes are read back via the private
 *  `staging` Uint8Array — that is exactly what flush() uploads to the GPU. */
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

/** The block's set.* surface as the test needs it (structurally typed — the
 *  full generated setter record is an implementation detail of POLYGON_U). */
interface FrameBlockLike {
  readonly set: {
    fill_color: (r: number, g: number, b: number, a: number) => void
    stroke_color: (r: number, g: number, b: number, a: number) => void
  }
}

/** Drive renderTileKeys for one tile with the pattern slots packed (through
 *  the typed UniformBlock, as render() does), then return the staged uniform
 *  floats. `fillPatternActive` / `linePatternActive` set the two guard flags
 *  the fix consults. */
function stageOneTile(opts: {
  fillUV: [number, number, number, number]
  lineUV: [number, number, number, number]
  fillPatternActive: boolean
  linePatternActive: boolean
}): Float32Array {
  const ctx = stubCtx
  const vtr = new VectorTileRenderer(ctx) as unknown as Record<string, unknown>

  // Inject the recording ring (bypass the GPU-bound _onUniformRingGrow path).
  const { ring, staging } = makeRecordingRing()
  vtr.uniformRing = ring

  // Make baseLayout()/baseGroup() return matching non-null sentinels so the
  // fillBg / currentTileBg resolution inside renderTileKeys passes. We pass the
  // SAME layout sentinel as fillBindGroupLayout so the `=== baseLayout()` arm
  // is taken (uniform-only base path — no per-tile feature group needed).
  const layoutSentinel = { __layout: true } as unknown as GPUBindGroupLayout
  const groupSentinel = { __group: true } as unknown as GPUBindGroup
  const reg = vtr._bindGroups as unknown as Record<string, unknown>
  reg.baseBindGroupLayout = layoutSentinel
  reg.tileBgDefault = groupSentinel

  // Resolved fill/stroke state: alpha 1 (so _skipFillDraw stays false-relevant;
  // the clobber writes baseFillA = 1*1 = 1.0 → distinct from the UV v1 values).
  vtr.cachedFillColor = [0.5, 0.5, 0.5, 1]
  vtr.cachedStrokeColor = [0.5, 0.5, 0.5, 1]
  vtr.currentOpacity = 1
  vtr._skipFillDraw = false
  vtr._patternUniformActive = opts.fillPatternActive
  vtr._linePatternActiveForShow = opts.linePatternActive

  // Pack the pattern UV bboxes exactly as render() does — through the typed
  // UniformBlock (#733), not a hand-indexed array.
  const B = vtr.frameBlock as FrameBlockLike
  B.set.fill_color(...opts.fillUV)
  B.set.stroke_color(...opts.lineUV)

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

describe('renderTileKeys pattern-UV slot clobber (fill_color.a fill v1, stroke_color.a line v1)', () => {
  const FILL_UV: [number, number, number, number] = [0.1, 0.2, 0.3, 0.4] // v1 = 0.4
  const LINE_UV: [number, number, number, number] = [0.5, 0.6, 0.7, 0.8] // v1 = 0.8
  // Lane indices from reflect() — the same source the packer uses (#733), no magic 16/23.
  const US = polygonUniformSlots().slot as Record<string, number>

  it('fill-pattern v1 (fill_color.a) survives the per-tile loop instead of being clobbered by alpha', () => {
    const staged = stageOneTile({
      fillUV: FILL_UV,
      lineUV: LINE_UV,
      fillPatternActive: true,
      linePatternActive: false,
    })
    // The whole fill-pattern UV bbox must reach the GPU intact.
    expect(staged[US.fill_color! + 0]).toBeCloseTo(0.1, 6)
    expect(staged[US.fill_color! + 1]).toBeCloseTo(0.2, 6)
    expect(staged[US.fill_color! + 2]).toBeCloseTo(0.3, 6)
    // v1 is the lane the bug clobbered with baseFillA (= 1.0) pre-fix.
    expect(staged[US.fill_color! + 3]).toBeCloseTo(0.4, 6)
  })

  it('line-pattern v1 (stroke_color.a) survives the per-tile loop instead of being clobbered by alpha', () => {
    const staged = stageOneTile({
      fillUV: FILL_UV,
      lineUV: LINE_UV,
      fillPatternActive: false,
      linePatternActive: true,
    })
    expect(staged[US.stroke_color! + 0]).toBeCloseTo(0.5, 6)
    expect(staged[US.stroke_color! + 1]).toBeCloseTo(0.6, 6)
    expect(staged[US.stroke_color! + 2]).toBeCloseTo(0.7, 6)
    // v1 is the lane the bug clobbered with baseStrokeA (= 1.0) pre-fix.
    expect(staged[US.stroke_color! + 3]).toBeCloseTo(0.8, 6)
  })

  it('NON-pattern path still writes the resolved alpha into fill_color.a/stroke_color.a (no behavior change)', () => {
    // Guard the fix's "only skip when a pattern owns the slot" contract: with
    // both flags false the per-tile loop MUST still write baseFillA/baseStrokeA
    // (= cachedColor.a * opacity = 1.0), overwriting whatever was in the lane.
    const staged = stageOneTile({
      fillUV: FILL_UV,
      lineUV: LINE_UV,
      fillPatternActive: false,
      linePatternActive: false,
    })
    expect(staged[US.fill_color! + 3]).toBeCloseTo(1.0, 6) // baseFillA
    expect(staged[US.stroke_color! + 3]).toBeCloseTo(1.0, 6) // baseStrokeA
  })
})
