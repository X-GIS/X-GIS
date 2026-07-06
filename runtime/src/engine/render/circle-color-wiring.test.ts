// circle-color: fill RGBA wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: circle-color is
// marked `supported` in compiler/src/convert/spec-coverage/paint-circle.ts
// and the circle capability table — it lowers to `fill-<color>` (see
// compiler/src/convert/layers-circle.ts circle-color → fill) which map.ts
// threads as the `fill` argument into PointRenderer.addLayer. But the prop's
// runtime contract — the fill colour reaching the GPU per-feature buffer —
// was verified only STRUCTURALLY / at compile time. A broken data path (the
// renderer dropping the fill colour, or writing a constant) would ship
// silently — the heatmap-class wiring bug.
//
// The runtime contract: PointRenderer.addLayer writes the per-feature
// feat_data (STRIDE = 24 floats) with the fill colour at slots 1,2,3 (R,G,B)
// and fill alpha × layer opacity at slot 4. The point fragment shader reads
// these as the disc fill colour. This drives the REAL PointRenderer.addLayer
// against the WebGPU stub (no GPU) and intercepts `device.queue.writeBuffer`
// to read the per-feature buffer the renderer uploads, asserting slots 1-4.
//
// Fail-before: drop / zero the `featData[off + 1] = fill ? fill[0] : 0` write
// (or stop threading `fill` into the per-feature buffer) and the red-channel
// assertion fails — the wiring that makes circle-color actually reach the GPU
// is gone, and the test catches it before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { PointRenderer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'

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

// One Point so the per-feature feat_data buffer write is unambiguous and its
// byte size (1 × STRIDE × 4 = 96) is distinct from every other buffer
// addLayer writes (vertices 64, indices 24). feat_data slots: radius @0,
// fill R,G,B @1,2,3, fill alpha × opacity @4.
const FEATURES = [{ geometry: { type: 'Point', coordinates: [10, 20] } }]
const STRIDE = 24
const FEAT_BYTES = STRIDE * 4 // 96 — the single-point per-feature buffer

// Distinctive, prop-dependent fill so each channel and the opacity multiply
// are unambiguous (no channel equals another, none equals 0 or 1).
const FILL: [number, number, number, number] = [0.2, 0.4, 0.6, 0.8]
const OPACITY = 0.5

interface Captured {
  /** per-feature feat_data (STRIDE floats) from the 96-byte addLayer write. */
  feat?: Float32Array
}

/** Add a single circle layer with the given fill + opacity and capture the
 *  per-feature feat_data bytes by intercepting `device.queue.writeBuffer`,
 *  keyed by the unique 96-byte buffer size. addLayer uploads the per-feature
 *  buffer synchronously, so no render() is needed. */
function captureFillUpload(ctx: GPUContext): Captured {
  const captured: Captured = {}
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
    captured.feat = f32.slice(0, STRIDE)
  }

  const renderer = new PointRenderer({
    device: ctx.device,
    format: ctx.format,
    rhi: new WebGpuDevice(ctx.device),
  })
  // addLayer(features, fill, stroke, strokeWidth, radiusPx, opacity, …).
  // No stroke so flags stay simple; opacity < 1 to prove the alpha multiply.
  renderer.addLayer(FEATURES as never, FILL, null, 0, 8, OPACITY)
  return captured
}

describe('circle-color fill RGBA wiring (GPU-free)', () => {
  it('addLayer registers exactly one layer for a Point set', async () => {
    const ctx = await makeCtx()
    const renderer = new PointRenderer({
      device: ctx.device,
      format: ctx.format,
      rhi: new WebGpuDevice(ctx.device),
    })
    expect(renderer.hasLayers()).toBe(false)
    renderer.addLayer(FEATURES as never, FILL, null, 0, 8, OPACITY)
    expect(renderer.hasLayers()).toBe(true)
  })

  it('per-feature feat_data threads fill R,G,B (@1,2,3) and alpha × opacity (@4)', async () => {
    const ctx = await makeCtx()
    const { feat } = captureFillUpload(ctx)
    expect(feat, 'per-feature feat_data buffer (96 B) should have been written').toBeTruthy()
    // Break `featData[off+1] = fill ? fill[0] : 0` (red) and this fails.
    expect(feat![1]).toBeCloseTo(FILL[0], 5)
    expect(feat![2]).toBeCloseTo(FILL[1], 5)
    expect(feat![3]).toBeCloseTo(FILL[2], 5)
    // Slot 4 = fill alpha × layer opacity — proves both the colour AND the
    // opacity multiply are wired (not a constant): 0.8 × 0.5 = 0.4.
    expect(feat![4]).toBeCloseTo(FILL[3] * OPACITY, 5)
  })
})
