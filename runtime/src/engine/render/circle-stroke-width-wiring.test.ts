// circle-stroke-width: per-feature buffer slot-9 wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: circle-stroke-width is
// marked `supported` in paint-circle spec-coverage + the circle capability
// table, but was verified only STRUCTURALLY. The runtime contract is: when a
// circle layer is added with a stroke colour and strokeWidth=W (raw px), the
// per-feature data the renderer uploads carries W at f32 slot 9; the point FS
// reads exactly that slot (point.ts:447 `featData.at(fid*STRIDE + 9)` →
// stroke_w_px) to draw the ring. If the field stops being threaded into the
// feat_data buffer, the stroke silently vanishes — a heatmap-class wiring break.
//
// This drives the REAL PointRenderer.addLayer + render() against the WebGPU
// stub (no GPU) and intercepts `device.queue.writeBuffer` to read the
// per-feature buffer the renderer uploads (1 point × STRIDE 24 × 4 = 96 B,
// distinct from the 144-B frame uniform and the 64-B vertex / 24-B index
// buffers), asserting slot 9 == strokeWidth.
//
// Fail-before: change `featData[off + 9] = strokeWidth` (point-renderer.ts
// addLayer) to write 0, and the slot-9 assertion fails — the wire that makes
// circle-stroke-width reach the GPU is gone, and the test catches it before
// any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '../gpu/gpu'
import { PointRenderer } from './point-renderer'
import { WebGpuDevice } from './rhi/rhi-webgpu'
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

const FEATURES = [{ geometry: { type: 'Point', coordinates: [10, 20] } }]
const FILL: [number, number, number, number] = [1, 0, 0, 1]
const STROKE: [number, number, number, number] = [0, 0, 1, 1]
const W = 1024
const H = 768

// Per-feature data stride (floats) — mirrors STRIDE in point-renderer.ts.
// circle-stroke-width lives at f32 slot 9 (raw px); the point FS reads
// featData.at(fid*STRIDE + 9) as stroke_w_px (point.ts:447).
const STRIDE = 24
const STROKE_WIDTH_SLOT = 9

// One feature → the per-feature (expanded) feat_data buffer the renderer
// uploads is 1 × STRIDE × 4 = 96 bytes, distinct from the 144-B frame uniform
// and the vertex / index buffers, so the size key is unambiguous.
const FEAT_BYTES = STRIDE * 4

/** Add a single circle layer with the given stroke width, run render() once,
 *  and return slot 9 (stroke_w_px) from the captured per-feature write. */
function capturedStrokeWidth(ctx: GPUContext, strokeWidth: number): number {
  const renderer = new PointRenderer({ device: ctx.device, format: ctx.format, rhi: new WebGpuDevice(ctx.device) })
  // addLayer positional head: features, fill, stroke, strokeWidth, radiusPx,
  // opacity, … . Stroke non-null + opaque (α = 1, opacity 1) so it draws.
  renderer.addLayer(
    FEATURES as never,
    FILL, STROKE, strokeWidth, 8, 1,
  )

  let slot9 = Number.NaN
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (buf: unknown, _off: number, data: ArrayBufferView | ArrayBuffer): void => {
    if ((buf as { size?: number })?.size !== FEAT_BYTES) return
    const f32 = data instanceof ArrayBuffer
      ? new Float32Array(data)
      : new Float32Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, STRIDE)
    slot9 = f32[STROKE_WIDTH_SLOT]
  }

  const camera = new Camera(10, 20, 8)
  camera.projType = 0
  const encoder = (ctx.device as unknown as {
    createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
  }).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.render(pass, camera, 0, 10, 20, W, H, 1)

  return slot9
}

describe('circle-stroke-width feat_data slot-9 wiring (GPU-free)', () => {
  it('feat_data slot 9 carries the raw stroke width (4)', async () => {
    const ctx = await makeCtx()
    expect(capturedStrokeWidth(ctx, 4)).toBeCloseTo(4, 5)
  })

  it('feat_data slot 9 tracks a different stroke width (1.5) — not a constant', async () => {
    const ctx = await makeCtx()
    expect(capturedStrokeWidth(ctx, 1.5)).toBeCloseTo(1.5, 5)
  })
})
