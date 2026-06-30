// Heatmap data-path wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: heatmap-radius /
// -weight / -intensity / -opacity are marked `supported` in
// compiler/src/convert/spec-coverage/paint-heatmap.ts, but the only runtime
// tests were the WGSL-compile smoke (architecture-invariants) and arch
// line-count — neither would catch a BROKEN DATA PATH where a paint field
// stops being threaded into the GPU buffers.
//
// This drives the REAL HeatmapRenderer.addLayer + drawLayerAccum against the
// WebGPU stub (no GPU) and intercepts `device.queue.writeBuffer` to read the
// bytes the renderer actually uploads:
//   • per-LAYER compose-params buffer (16 B) carries [intensity, opacity]
//   • per-FEATURE feat_data buffer carries radius_px @slot 0, weight @slot 1
//
// Fail-before: break the radius wiring (e.g. drop the `featData[fOff + 0] =
// layer.radiusPx` write, or stop threading `radiusPx` through addLayer) and
// the radius assertion fails — the field is no longer "supported", and the
// test says so before a render ever runs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/engine'
import { HeatmapRenderer } from './heatmap-renderer'
import { WebGpuDevice } from '@xgis/engine'
import { Camera } from '../projection/camera'

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800; height = 600
      getContext(_t: string): unknown { return null }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => { stub.uninstall() })

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1024, height: 768 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

// The accum feat_data stride (floats per point) — mirrors STRIDE in
// heatmap-renderer.ts. radius_px @slot 0, weight @slot 1.
const STRIDE = 24

// Three known points so the per-feature buffer write is unambiguous and its
// byte size (3 × 24 × 4 = 288) is distinct from every other buffer the
// renderer writes (params 16, uniform 128, verts 192, indices 72).
const FEATURES = [
  { geometry: { type: 'Point', coordinates: [10, 20] } },
  { geometry: { type: 'Point', coordinates: [11, 21] } },
  { geometry: { type: 'Point', coordinates: [12, 22] } },
]
const N = FEATURES.length

const RADIUS = 37
const WEIGHT = 2.5
const INTENSITY = 0.75
const OPACITY = 0.6

interface Captured {
  /** [intensity, opacity] from the per-layer compose-params buffer (16 B). */
  params?: Float32Array
  /** per-feature feat_data (3 × STRIDE floats). */
  feat?: Float32Array
}

/** Drive addLayer + a single accum draw and capture the uploaded bytes by
 *  intercepting `device.queue.writeBuffer`, keyed by buffer byte-size. */
function captureHeatmapUploads(ctx: GPUContext): Captured {
  const captured: Captured = {}
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (buf: unknown, _off: number, data: ArrayBufferView | ArrayBuffer): void => {
    const size = (buf as { size?: number })?.size
    const f32 = data instanceof ArrayBuffer
      ? new Float32Array(data)
      : new Float32Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset,
          (data as ArrayBufferView).byteLength / 4)
    if (size === 16) captured.params = f32.slice(0, 4)        // compose-params
    else if (size === N * STRIDE * 4) captured.feat = f32.slice(0, N * STRIDE) // feat_data
  }

  const renderer = new HeatmapRenderer({ device: ctx.device, rhi: new WebGpuDevice(ctx.device) })
  renderer.addLayer(FEATURES as never, RADIUS, WEIGHT, INTENSITY, OPACITY)

  const camera = new Camera(11, 21, 5)
  renderer.updateFrameUniform(camera, 0, 11, 21, 1024, 768, 1)

  const encoder = (ctx.device as unknown as {
    createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
  }).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.drawLayerAccum(pass, 0)

  return captured
}

describe('heatmap data-path wiring (GPU-free)', () => {
  it('addLayer registers exactly one layer for a Point set', async () => {
    const ctx = await makeCtx()
    const renderer = new HeatmapRenderer({ device: ctx.device, rhi: new WebGpuDevice(ctx.device) })
    expect(renderer.hasLayers()).toBe(false)
    renderer.addLayer(FEATURES as never, RADIUS, WEIGHT, INTENSITY, OPACITY)
    expect(renderer.hasLayers()).toBe(true)
    expect(renderer.getLayers().length).toBe(1)
  })

  it('per-layer compose-params buffer carries intensity + opacity', async () => {
    const ctx = await makeCtx()
    const { params } = captureHeatmapUploads(ctx)
    expect(params, 'compose-params buffer (16 B) should have been written').toBeTruthy()
    // Break the intensity/opacity threading → these fail.
    expect(params![0]).toBeCloseTo(INTENSITY, 5)
    expect(params![1]).toBeCloseTo(OPACITY, 5)
  })

  it('per-feature feat_data threads radius_px (@0) and weight (@1)', async () => {
    const ctx = await makeCtx()
    const { feat } = captureHeatmapUploads(ctx)
    expect(feat, 'feat_data buffer should have been written').toBeTruthy()
    for (let i = 0; i < N; i++) {
      const off = i * STRIDE
      // radius wiring — drop `featData[fOff+0] = layer.radiusPx` and this fails.
      expect(feat![off + 0]).toBeCloseTo(RADIUS, 5)
      // weight wiring — heatmap-weight × per-feature (here per-feature = 1).
      expect(feat![off + 1]).toBeCloseTo(WEIGHT, 5)
    }
  })
})
