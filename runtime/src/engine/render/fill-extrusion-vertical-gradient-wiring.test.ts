// fill-extrusion-vertical-gradient data-path wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: paint
// `fill-extrusion-vertical-gradient` (Mapbox/xgis) is marked `supported`. The
// default `true` applies the 0.7→1.0 wall ramp matching MapLibre; the `false`
// opt-out flattens wall shading. render() resolves the flag into
// VectorTileRenderer.currentFillVerticalGradient (1 default / 0 when the style
// sets it false), and the per-tile loop packs it into the spare cam_ecef_off_l.w
// lane of the polygon uniform
//   uniformF32[59] = this.currentFillVerticalGradient   (vector-tile-renderer.ts:3726)
// which the extrude vertex shader ANDs into its per-wall gradient test.
//
// The wire is a 0/1 flag, so non-vacuity needs BOTH states: a live wire stages
// 1 for the default and 0 for the opt-out. A constant break (always 1) passes
// the default case but fails the opt-out case → the test catches it.
//
// Harness: mirrors fill-extrusion-height-wiring.test.ts.
//
// Fail-before: replace `this.uniformF32[59] = this.currentFillVerticalGradient`
// with `this.uniformF32[59] = 1` and the opt-out (0) assertion fails.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU } from '@xgis/rhi-webgpu'
import { VectorTileRenderer } from '@xgis/map'
import { UniformRing } from '@xgis/map'
import { polygonUniformStride } from '@xgis/map'

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
    return new Float32Array(u8.buffer, u8.byteOffset, UNIFORM_SLOT / 4)
  }
  return { ring, staging }
}

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
    extruded: true,
    featureBindGroup: null,
  } as unknown as import('@xgis/map').GPUTile
}

/** Drive renderTileKeys for one tile with a resolved vertical-gradient flag,
 *  then return the staged uniform floats. The flag (uf[59]) is written from
 *  this.currentFillVerticalGradient by the per-tile loop. */
function stageOneTile(verticalGradient: number): Float32Array {
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
  vtr.currentFillVerticalGradient = verticalGradient

  const layerCache = new Map<number, unknown>()
  const KEY = 12345
  layerCache.set(KEY, stubTile())

  const passStub = {} as unknown as GPURenderPassEncoder

  ;(vtr.renderTileKeys as (...a: unknown[]) => void).call(
    vtr,
    [KEY],
    passStub,
    {} as GPURenderPipeline,
    {} as GPURenderPipeline,
    0,
    0,
    undefined,
    0,
    -1,
    'fills',
    layerCache,
    null,
    layoutSentinel,
  )

  return staging()
}

describe('fill-extrusion-vertical-gradient data-path wiring (GPU-free)', () => {
  it('default (true) stages the gradient flag = 1 into uf[59]', () => {
    const staged = stageOneTile(1)
    expect(staged[59]).toBeCloseTo(1, 6)
  })

  it('opt-out (false) stages the gradient flag = 0 into uf[59] (catches a constant break)', () => {
    const staged = stageOneTile(0)
    // Break `uniformF32[59] = currentFillVerticalGradient` → constant 1 → this fails.
    expect(staged[59]).toBeCloseTo(0, 6)
  })
})
