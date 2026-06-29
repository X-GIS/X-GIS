// raster-saturation uniform wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: raster-saturation is
// marked `supported` (constant -1..1) in the raster capability table, but its
// runtime wiring was never verified behaviorally — only that the prop is
// "supported" and that the WGSL compiles. A broken data path (the renderer
// stops threading `_saturation` into the GPU uniform) would ship silently — the
// heatmap-class bug.
//
// The runtime contract: when a raster show authors raster-saturation=s, the
// orchestrator calls RasterRenderer.setColorAdjust(…, s, …); render() then
// writes s into the 160-byte raster uniform's `raster_color0` at byte offset 96,
// the .w lane — f32 slot 27 (raster-renderer.ts:314) — which the raster
// fragment shader reads as the HSL saturation multiplier. Default 0 = no-op.
//
// This drives the REAL RasterRenderer.render() against the WebGPU stub (no GPU)
// and intercepts `device.queue.writeBuffer` to read the 160-byte global uniform,
// asserting slot 27. Mirrors raster-hue-rotate-wiring.test.ts.
//
// Fail-before: in raster-renderer.ts:314 change the raster_color0 write's last
// element from `this._saturation` to `0` and the s-case assertion fails — the
// wiring that makes raster-saturation reach the GPU is gone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '../gpu/gpu'
import { RasterRenderer } from './raster-renderer'
import { Camera } from '../projection/camera'
import { rasterUniformBytes } from './raster-uniform-slots'

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

// raster_color0 @96 → f32 slot 24; its .w lane (slot 27) is saturation
// (raster-renderer.ts:314). The reflect-derived global-uniform byte size
// uniquely identifies the global uniform write (per-tile pooled uniforms are
// 48 B).
const RASTER_COLOR0_W = 27 // (96 / 4) + 3

/** Set raster-saturation via setColorAdjust, run render() once, and return
 *  raster_color0.w from the captured 160-byte global-uniform write. */
function capturedSaturation(ctx: GPUContext, saturation: number): number {
  const UNIFORM_BYTES = rasterUniformBytes()
  const renderer = new RasterRenderer(ctx)
  renderer.setUrlTemplate('https://example.invalid/{z}/{x}/{y}.png')
  // Only saturation is exercised; hue/brightness/contrast stay at spec no-ops.
  renderer.setColorAdjust(0, 0, 1, saturation, 0)

  let captured = Number.NaN
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (buf: unknown, _off: number, data: ArrayBufferView | ArrayBuffer): void => {
    if ((buf as { size?: number })?.size !== UNIFORM_BYTES) return
    const f32 = data instanceof ArrayBuffer
      ? new Float32Array(data)
      : new Float32Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, 40)
    captured = f32[RASTER_COLOR0_W]
  }

  const camera = new Camera(10, 20, 5)
  camera.projType = 0
  const encoder = (ctx.device as unknown as {
    createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
  }).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.render(pass, camera, 0, 10, 20, W, H, 1)

  return captured
}

describe('raster-saturation uniform wiring (GPU-free)', () => {
  it('raster_color0.w carries the authored saturation', async () => {
    const ctx = await makeCtx()
    // A distinctive non-default value so the assertion is non-vacuous.
    expect(capturedSaturation(ctx, 0.6)).toBeCloseTo(0.6, 5)
  })

  it('raster_color0.w = 0 for the default (un-authored) no-op', async () => {
    const ctx = await makeCtx()
    expect(capturedSaturation(ctx, 0)).toBeCloseTo(0, 5)
  })
})
