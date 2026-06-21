// fill-extrusion-translate data-path wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: paint
// `fill-extrusion-translate` (Mapbox/xgis) is marked `supported`. It rides the
// SHARED fill-translate utilities + slot 46/47 uniform: render() resolves the
// per-frame [dx,dy] CSS-px offset into NDC and caches it as
// VectorTileRenderer.currentFillTranslateNdc{X,Y}; the per-tile loop in
// renderTileKeys writes those into the staged uniform's fill_translate slots
//   uniformF32[46] = this.currentFillTranslateNdcX   (vector-tile-renderer.ts:3854)
//   uniformF32[47] = this.currentFillTranslateNdcY   (vector-tile-renderer.ts:3855)
// (else-branch: only when NO pattern owns the slot). The extrude vertex shaders
// apply u.fill_translate to clip += offset * clip.w, so the offset stays pixel-
// constant with depth — the same wire fill-extrusion-translate inherits.
//
// Harness: mirrors fill-extrusion-height-wiring.test.ts. The asserted values
// TRACK the prop (distinct X and Y, never a constant) → non-vacuous.
//
// Fail-before: replace `this.uniformF32[46] = this.currentFillTranslateNdcX`
// with `this.uniformF32[46] = 0` and the slot-46 assertion fails.

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

/** Drive renderTileKeys with a resolved fill-translate NDC offset, then return
 *  the staged uniform floats. fill_translate (uf[46/47]) is written from
 *  this.currentFillTranslateNdc{X,Y} by the per-tile loop (no-pattern branch). */
function stageOneTile(ndcX: number, ndcY: number): Float32Array {
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
  vtr._patternUniformActive = false   // → uf[46/47] take the fill-translate branch
  vtr._linePatternActiveForShow = false
  vtr.currentFillTranslateNdcX = ndcX
  vtr.currentFillTranslateNdcY = ndcY

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

describe('fill-extrusion-translate data-path wiring (GPU-free)', () => {
  it('staged fill_translate (uf[46], uf[47]) carries the resolved NDC offset', () => {
    // Distinct, asymmetric X/Y so neither lane can vacuously match the other.
    const staged = stageOneTile(0.125, -0.0625)
    // Break `uniformF32[46] = currentFillTranslateNdcX` → 0 → slot-46 fails.
    expect(staged[46]).toBeCloseTo(0.125, 6)
    expect(staged[47]).toBeCloseTo(-0.0625, 6)
  })

  it('fill_translate tracks a second distinct offset (proves it is not a constant)', () => {
    const staged = stageOneTile(-0.03, 0.21)
    expect(staged[46]).toBeCloseTo(-0.03, 6)
    expect(staged[47]).toBeCloseTo(0.21, 6)
  })
})
