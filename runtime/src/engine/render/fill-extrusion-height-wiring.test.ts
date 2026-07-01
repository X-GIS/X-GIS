// fill-extrusion-height data-path wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: paint
// `fill-extrusion-height` (Mapbox/xgis) is marked `supported` and rests on
// STRUCTURAL/compile tests, so a broken render-wire would ship silently (the
// heatmap-class bug). The runtime contract for the 3D wall height: render()
// resolves the constant/feature-fallback height into
// VectorTileRenderer.currentExtrudeHeight, and the per-tile loop in
// renderTileKeys writes it into the staged uniform's extrude_height_m slot
//   uniformF32[39] = this.currentExtrudeHeight       (vector-tile-renderer.ts:3788)
// which is then uploaded to the GPU. The extrude vertex shader multiplies the
// per-vertex is_top flag by u.extrude_height_m to lift the roof.
//
// This is the extrude-SPECIFIC wire (uf[39]), distinct from fill-color's
// uf[16..19] — a fill-extrusion-color test would merely re-prove the shared
// fill_color slots, so the genuinely-new extrude wires are height (uf[39]),
// base (uf[45]) and vertical-gradient (uf[59]).
//
// Harness: mirrors fill-color-wiring.test.ts — drive the REAL renderTileKeys
// over one minimal cached tile (all geometry counts 0 → no GPU draw is emitted;
// the per-tile loop still runs the uniform pack + stageUniformSlot + flush) and
// read the bytes staged into the uniform ring (the ground truth that reaches
// the GPU). The asserted value TRACKS the prop (250 then 80.5, never a
// constant) → non-vacuous.
//
// Fail-before: replace `this.uniformF32[39] = this.currentExtrudeHeight`
// with `this.uniformF32[39] = 0` (or any constant) and the slot-39 assertions
// fail — the fill-extrusion-height wire is gone, and the test says so before
// any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU } from '@xgis/engine'
import { VectorTileRenderer } from '@xgis/map'
import { UniformRing } from '@xgis/map'
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

/** A UniformRing backed by a write-recording fake device. The staged bytes are
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
 *  reaches the uniform pack WITHOUT emitting any drawIndexed / drawSegments. */
function stubTile() {
  return {
    lastUsedFrame: 0,
    tileWest: 0, tileSouth: 0, tileZoom: 4,
    indexCount: 0, lineIndexCount: 0,
    outlineSegmentCount: 0, lineSegmentCount: 0,
    dequantScale: 1, dequantHalf: 0,
    extruded: true,
    featureBindGroup: null,
  } as unknown as import('@xgis/map').GPUTile
}

/** Drive renderTileKeys for one tile with a resolved extrude height, then
 *  return the staged uniform floats. extrude_height_m (uf[39]) is written from
 *  this.currentExtrudeHeight by the per-tile loop. */
function stageOneTile(extrudeHeight: number): Float32Array {
  const ctx = stubCtx
  const vtr = new VectorTileRenderer(ctx) as unknown as Record<string, unknown>

  const { ring, staging } = makeRecordingRing()
  vtr.uniformRing = ring

  const layoutSentinel = { __layout: true } as unknown as GPUBindGroupLayout
  const groupSentinel = { __group: true } as unknown as GPUBindGroup
  const reg = vtr._bindGroups as Record<string, unknown>
  reg.baseBindGroupLayout = layoutSentinel
  reg.tileBgDefault = groupSentinel

  // Non-zero fill so the per-tile loop runs the full pack (no skip-fill short
  // circuit on the uniform write). The extrude height is the wire under test.
  vtr.cachedFillColor = [0.2, 0.4, 0.6, 1]
  vtr.cachedStrokeColor = [0.5, 0.5, 0.5, 1]
  vtr.currentOpacity = 1
  vtr._skipFillDraw = false
  vtr._patternUniformActive = false
  vtr._linePatternActiveForShow = false
  vtr.currentExtrudeHeight = extrudeHeight

  const layerCache = new Map<number, unknown>()
  const KEY = 12345
  layerCache.set(KEY, stubTile())

  const passStub = {} as unknown as GPURenderPassEncoder

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
    -1,                      // lineLayerOffsetGap
    'fills',                 // phase
    layerCache,              // layerCache
    null,                    // fillPipelineExtruded
    layoutSentinel,          // fillBindGroupLayout (=== baseLayout())
  )

  return staging()
}

describe('fill-extrusion-height data-path wiring (GPU-free)', () => {
  it('staged extrude_height_m (uf[39]) carries the resolved fill-extrusion-height', () => {
    const staged = stageOneTile(250)
    // Break `uniformF32[39] = currentExtrudeHeight` → 0 / constant → this fails.
    expect(staged[39]).toBeCloseTo(250, 4)
  })

  it('extrude_height_m tracks the height value (proves it is not a constant)', () => {
    const staged = stageOneTile(80.5)
    // A second, distinct height — only a live wire reads currentExtrudeHeight.
    expect(staged[39]).toBeCloseTo(80.5, 4)
  })
})
