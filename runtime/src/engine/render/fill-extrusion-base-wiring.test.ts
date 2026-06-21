// fill-extrusion-base data-path wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: paint
// `fill-extrusion-base` (Mapbox/xgis) is marked `supported` and rests on
// STRUCTURAL/compile tests, so a broken render-wire would ship silently. The
// runtime contract for the wall bottom: render() resolves the constant/feature-
// fallback base into VectorTileRenderer.currentExtrudeBase, and the per-tile
// loop in renderTileKeys writes it into the staged uniform's extrude_base_m slot
//   uniformF32[45] = this.currentExtrudeBase         (vector-tile-renderer.ts:3841)
// which is then uploaded to the GPU. The extrude vertex shader lifts the wall
// floor to u.extrude_base_m so partially-buried walls start above ground.
//
// This is the extrude-SPECIFIC wire (uf[45]), distinct from fill-color's
// uf[16..19] and from extrude_height_m (uf[39]).
//
// Harness: mirrors fill-extrusion-height-wiring.test.ts — drive the REAL
// renderTileKeys over one minimal cached tile (geometry counts 0 → no GPU draw)
// and read the bytes staged into the uniform ring. The asserted value TRACKS
// the prop (12 then 3.25, never a constant) → non-vacuous.
//
// Fail-before: replace `this.uniformF32[45] = this.currentExtrudeBase` with
// `this.uniformF32[45] = 0` and the slot-45 assertions fail.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU } from '../gpu/gpu'
import { VectorTileRenderer } from './vector-tile-renderer'
import { UniformRing } from './uniform-ring'

const UNIFORM_SLOT = 256

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

function makeRecordingRing(): { ring: UniformRing; staging: () => Float32Array } {
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

function stubTile() {
  return {
    lastUsedFrame: 0,
    tileWest: 0, tileSouth: 0, tileZoom: 4,
    indexCount: 0, lineIndexCount: 0,
    outlineSegmentCount: 0, lineSegmentCount: 0,
    dequantScale: 1, dequantHalf: 0,
    extruded: true,
    featureBindGroup: null,
  } as unknown as import('./vector-tile-renderer-types').GPUTile
}

/** Drive renderTileKeys for one tile with a resolved extrude base, then return
 *  the staged uniform floats. extrude_base_m (uf[45]) is written from
 *  this.currentExtrudeBase by the per-tile loop. */
function stageOneTile(extrudeBase: number): Float32Array {
  const ctx = stubCtx
  const vtr = new VectorTileRenderer(ctx) as unknown as Record<string, unknown>

  const { ring, staging } = makeRecordingRing()
  vtr.uniformRing = ring

  const layoutSentinel = { __layout: true } as unknown as GPUBindGroupLayout
  const groupSentinel = { __group: true } as unknown as GPUBindGroup
  const reg = vtr._bindGroups as Record<string, unknown>
  reg.baseBindGroupLayout = layoutSentinel
  reg.tileBgDefault = groupSentinel

  vtr.cachedFillColor = [0.2, 0.4, 0.6, 1]
  vtr.cachedStrokeColor = [0.5, 0.5, 0.5, 1]
  vtr.currentOpacity = 1
  vtr._skipFillDraw = false
  vtr._patternUniformActive = false
  vtr._linePatternActiveForShow = false
  vtr.currentExtrudeBase = extrudeBase

  const layerCache = new Map<number, unknown>()
  const KEY = 12345
  layerCache.set(KEY, stubTile())

  const passStub = {} as unknown as GPURenderPassEncoder

  ;(vtr.renderTileKeys as (...a: unknown[]) => void).call(
    vtr,
    [KEY], passStub,
    {} as GPURenderPipeline, {} as GPURenderPipeline,
    0, 0, undefined, 0, -1, 'fills', layerCache, null, layoutSentinel,
  )

  return staging()
}

describe('fill-extrusion-base data-path wiring (GPU-free)', () => {
  it('staged extrude_base_m (uf[45]) carries the resolved fill-extrusion-base', () => {
    const staged = stageOneTile(12)
    // Break `uniformF32[45] = currentExtrudeBase` → 0 / constant → this fails.
    expect(staged[45]).toBeCloseTo(12, 4)
  })

  it('extrude_base_m tracks the base value (proves it is not a constant)', () => {
    const staged = stageOneTile(3.25)
    expect(staged[45]).toBeCloseTo(3.25, 4)
  })
})
