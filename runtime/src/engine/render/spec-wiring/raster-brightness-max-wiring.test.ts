// raster-brightness-max wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: raster-brightness-max
// is marked `supported` in compiler/src/convert/spec-coverage/paint-raster.ts
// + the raster capability table, but its RUNTIME wiring (the colour-adjust
// value actually reaching the GPU uniform the fragment shader reads) had no
// behavioral test — only structural/compile coverage. A broken data path
// (the field stops being threaded into the uniform) would ship silently.
//
// The runtime contract: RasterRenderer.setColorAdjust(..., brightnessMax, ...)
// stores `_brightnessMax`, and render() packs it into the 160-byte global
// raster uniform at `raster_color0` (byte offset 96 = f32 slot 24), component
// .z = f32 slot 26 → [hueRotateDeg, brightnessMin, brightnessMax, saturation]
// (raster-renderer.ts:314). The fragment shader reads raster_color0.z to set
// the upper end of the brightness remap.
//
// This drives the REAL RasterRenderer.render() against the WebGPU stub (no
// GPU) and intercepts `device.queue.writeBuffer`, keyed by the 160-byte global
// uniform buffer, to read the bytes the renderer actually uploads — asserting
// slot 26 carries the brightnessMax we set. A url template is set so render()
// doesn't early-return; no tiles are cached, so the 160-byte global uniform
// write is the ONLY writeBuffer call and it carries the value under test.
//
// Fail-before: replace `this._brightnessMax` in the raster_color0 `.set([...])`
// at raster-renderer.ts:314 with a constant (e.g. 0) — the field no longer
// reaches the GPU and the brightnessMax assertion fails before any render.

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

// The global raster uniform is the reflect-derived 'Uniforms' buffer
// (raster-renderer.ts:117). raster_color0 sits at byte offset 96 → f32 slot 24;
// component .z (the 3rd of [hueRotateDeg, brightnessMin, brightnessMax,
// saturation]) = f32 slot 26.
const RASTER_COLOR0_Z = 26

/** Add the colour adjust, run render() once with a url template set (no tiles
 *  cached → the 160-byte global uniform is the only writeBuffer), and return
 *  raster_color0.z from the captured global uniform upload. */
function capturedBrightnessMax(ctx: GPUContext, brightnessMax: number): number {
  const UNIFORM_BYTES = rasterUniformBytes()
  const renderer = new RasterRenderer(ctx)
  renderer.setUrlTemplate('https://example.invalid/{z}/{x}/{y}.png')
  // setColorAdjust(hueRotate, brightnessMin, brightnessMax, saturation, contrast).
  // Spec default brightnessMin 0 / brightnessMax 1; we drive brightnessMax only.
  renderer.setColorAdjust(0, 0, brightnessMax, 0, 0)

  let value = Number.NaN
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (buf: unknown, _off: number, data: ArrayBufferView | ArrayBuffer): void => {
    if ((buf as { size?: number })?.size !== UNIFORM_BYTES) return
    const f32 = data instanceof ArrayBuffer
      ? new Float32Array(data)
      : new Float32Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset,
          (data as ArrayBufferView).byteLength / 4)
    value = f32[RASTER_COLOR0_Z]
  }

  const camera = new Camera(10, 20, 5)
  camera.projType = 0
  const encoder = (ctx.device as unknown as {
    createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
  }).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.render(pass, camera, 0, 10, 20, W, H, 1)

  return value
}

describe('raster-brightness-max wiring (GPU-free)', () => {
  it('raster_color0.z carries the authored brightnessMax', async () => {
    const ctx = await makeCtx()
    // Distinct from every default (hue 0, brightnessMin 0, saturation 0,
    // contrast 0) AND from the brightnessMax default 1, so the assertion is
    // non-vacuous: it can only pass if THIS value is threaded to THIS slot.
    expect(capturedBrightnessMax(ctx, 0.42)).toBeCloseTo(0.42, 5)
  })

  it('raster_color0.z follows a different brightnessMax (proves it tracks the prop)', async () => {
    const ctx = await makeCtx()
    expect(capturedBrightnessMax(ctx, 0.83)).toBeCloseTo(0.83, 5)
  })
})
