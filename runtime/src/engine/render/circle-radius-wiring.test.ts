// circle-radius: feat_data slot-0 (radius_px) wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: circle-radius is marked
// `supported` in paint-circle spec-coverage + the circle capability table, but
// was verified only STRUCTURALLY / via the SDF-shader compile smoke — neither
// catches a BROKEN DATA PATH where the radius stops being threaded into the
// per-feature GPU buffer.
//
// The runtime contract: PointRenderer.addLayer(..., radiusPx, ...) writes the
// authored radius into feat_data slot 0 (point-renderer.ts:557), and render()
// copies slots 0-10 verbatim into the per-layer expanded feat buffer it uploads
// (point-renderer.ts:784/851). The point VS reads slot 0 as the quad
// half-extent in px (see point-uniform / point.ts). So slot 0 of the uploaded
// per-feature buffer MUST equal the radius the layer was authored with.
//
// This drives the REAL PointRenderer.addLayer + render() against the WebGPU
// stub (no GPU) and intercepts `device.queue.writeBuffer` to read the
// per-feature expanded buffer (1 point → 24 floats → 96 bytes, a size distinct
// from the 144-byte uniform / 256-byte vertex / 24-byte index buffers the
// renderer also writes), asserting feat_data slot 0.
//
// Fail-before: break the radius wiring at point-renderer.ts:557 (e.g.
//   `featData[off + 0] = perFeatureSizes ? perFeatureSizes[i] : 0`)
// and the radius assertion fails — the field is no longer "supported", and the
// test says so before any render. The negative control (two different radii →
// two different slot-0 values) proves the assertion tracks the PROP, not a
// constant.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { PointRenderer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import { Camera } from '@xgis/map'

let stub: StubInstallation

beforeEach(() => {
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
})
afterEach(() => {
  stub.uninstall()
})

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1024, height: 768 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

// One point so the per-feature buffer byte-size is unambiguous:
//   feat_data = 1 × STRIDE(24) × 4 = 96 bytes — distinct from the 144-byte
//   uniform, the 256-byte vertex (1 × 4 verts × 4 floats × 4) and the 24-byte
//   index buffer the renderer also queue.writeBuffer's.
const FEATURES = [{ geometry: { type: 'Point', coordinates: [10, 20] } }]
const FILL: [number, number, number, number] = [1, 0, 0, 1] // opaque → phase-1 draw
const W = 1024
const H = 768

const STRIDE = 24
const FEAT_BYTES = STRIDE * 4 // 96 — one point
const RADIUS_SLOT = 0 // feat_data slot 0 = radius_px

/** Add a single opaque circle layer with the given circle-radius, run render()
 *  once, and return feat_data slot 0 from the per-feature buffer the renderer
 *  actually uploads. */
function capturedRadiusSlot(ctx: GPUContext, radiusPx: number): number {
  const renderer = new PointRenderer({
    device: ctx.device,
    format: ctx.format,
    rhi: new WebGpuDevice(ctx.device),
  })
  // addLayer positional head: features, fill, stroke, strokeWidth, radiusPx, opacity.
  renderer.addLayer(FEATURES as never, FILL, null, 1, radiusPx, 1)

  let slot0 = Number.NaN
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (
    buf: unknown,
    _off: number,
    data: ArrayBufferView | ArrayBuffer,
  ): void => {
    if ((buf as { size?: number })?.size !== FEAT_BYTES) return
    const f32 =
      data instanceof ArrayBuffer
        ? new Float32Array(data)
        : new Float32Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            STRIDE,
          )
    slot0 = f32[RADIUS_SLOT]
  }

  const camera = new Camera(10, 20, 8)
  camera.projType = 0
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.render(pass, camera, 0, 10, 20, W, H, 1)

  return slot0
}

describe('circle-radius feat_data slot-0 wiring (GPU-free)', () => {
  it('feat_data slot 0 carries the authored circle-radius', async () => {
    const ctx = await makeCtx()
    // Break point-renderer.ts:557 → this fails.
    expect(capturedRadiusSlot(ctx, 37)).toBeCloseTo(37, 5)
  })

  it('slot 0 tracks the prop (different radius → different slot value)', async () => {
    const ctx = await makeCtx()
    // Negative control: assertion is non-vacuous — slot 0 is NOT a constant.
    expect(capturedRadiusSlot(ctx, 5)).toBeCloseTo(5, 5)
    expect(capturedRadiusSlot(ctx, 21)).toBeCloseTo(21, 5)
  })
})
