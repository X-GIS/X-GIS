// raster-brightness-min: raster_color0.y uniform wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: raster-brightness-min is
// marked `supported` in compiler/src/convert/spec-coverage/paint-raster.ts + the
// raster capability table, but its RUNTIME wiring rested only on structural /
// compile coverage. The contract is: the value the orchestrator resolves for
// `raster-brightness-min` (opaque-pass.ts:142 → RasterRenderer.setColorAdjust,
// raster-renderer.ts:188) is stored in `_brightnessMin` (raster-renderer.ts:192)
// and uploaded into the 160-byte raster uniform buffer's `raster_color0.y`
// — byte offset 100, f32 slot 25 (raster-renderer.ts:314). The raster FS reads
// that slot to apply the brightness floor; a broken thread (e.g. writing 0)
// ships a silently-dead property.
//
// This drives the REAL RasterRenderer.setColorAdjust + render() against the
// WebGPU stub (no GPU) and intercepts `device.queue.writeBuffer` to read the
// 160-byte uniform the renderer uploads, asserting f32 slot 25 == brightnessMin.
//
// Fail-before: change `this._brightnessMin = …` to write a constant (e.g. 0), or
// drop the `this._brightnessMin` term from the raster_color0 write, and the
// assertion fails — the wiring that makes raster-brightness-min actually reach
// the GPU is gone, and the test catches it before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '../../gpu/gpu'
import { RasterRenderer } from '../raster-renderer'
import { Camera } from '../../projection/camera'
import { rasterUniformBytes } from '../raster-uniform-slots'

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

const W = 1024
const H = 768

// The raster global uniform is the reflect-derived 'Uniforms' buffer
// (raster-renderer.ts:117). raster_color0 sits at byte offset 96 → f32 indices
// 24..27, laid out as (hueRotateDeg, brightnessMin, brightnessMax, saturation).
// brightnessMin is the .y lane → f32 slot 25. (raster-renderer.ts:313-314.)
const BRIGHTNESS_MIN_SLOT = 25

// A value that is NOT a spec default (default brightnessMin = 0) and is in-range
// [0,1] so the renderer's clamp passes it through unchanged — so an assertion on
// it is non-vacuous: only the prop thread can produce it.
const BRIGHTNESS_MIN = 0.375

/** Add a URL template (so render() doesn't early-return), push brightnessMin via
 *  the same setColorAdjust the orchestrator calls, run render() once, and return
 *  the raster_color0.y lane from the captured 160-byte uniform write. */
function capturedBrightnessMin(ctx: GPUContext, brightnessMin: number): number {
  const UNIFORM_BYTES = rasterUniformBytes()
  const renderer = new RasterRenderer(ctx)
  renderer.setUrlTemplate('https://example.invalid/{z}/{x}/{y}.png')
  // Mirror opaque-pass.ts:140-145 positional order:
  // (hueRotate, brightnessMin, brightnessMax, saturation, contrast).
  renderer.setColorAdjust(0, brightnessMin, 1, 0, 0)

  let lane = Number.NaN
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (buf: unknown, _off: number, data: ArrayBufferView | ArrayBuffer): void => {
    if ((buf as { size?: number })?.size !== UNIFORM_BYTES) return
    const f32 = data instanceof ArrayBuffer
      ? new Float32Array(data)
      : new Float32Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset,
          (data as ArrayBufferView).byteLength / 4)
    lane = f32[BRIGHTNESS_MIN_SLOT]
  }

  const camera = new Camera(10, 20, 5)
  camera.projType = 0
  const encoder = (ctx.device as unknown as {
    createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
  }).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.render(pass, camera, 0, 10, 20, W, H, 1)

  return lane
}

describe('raster-brightness-min uniform wiring (GPU-free)', () => {
  it('raster_color0.y (f32 slot 25) carries the resolved brightnessMin', async () => {
    const ctx = await makeCtx()
    expect(capturedBrightnessMin(ctx, BRIGHTNESS_MIN)).toBeCloseTo(BRIGHTNESS_MIN, 5)
  })

  it('raster_color0.y is the spec-default 0 when brightnessMin is left at default', async () => {
    const ctx = await makeCtx()
    expect(capturedBrightnessMin(ctx, 0)).toBeCloseTo(0, 5)
  })
})
