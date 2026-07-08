// raster-hue-rotate uniform wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: raster-hue-rotate is
// marked `supported` (constant) in the raster capability table
// (runtime/src/capabilities/raster.ts:10) and resolved per frame by the
// opaque-pass orchestrator (passes/opaque-pass.ts:140-141), but its runtime
// wiring was never verified behaviorally — only that the prop is "supported"
// and that the WGSL compiles. A broken data path (the renderer stops threading
// `_hueRotate` into the GPU uniform) would ship silently — the heatmap-class
// bug.
//
// The runtime contract: when a raster show authors raster-hue-rotate=θ, the
// orchestrator calls RasterRenderer.setColorAdjust(θ, …); render() then writes
// θ into the 160-byte raster uniform's `raster_color0` at byte offset 96 —
// f32 slot 24, the .x lane — which the raster fragment shader reads to rotate
// the sampled texel's hue. Default (un-authored) is 0 = a hard no-op.
//
// This drives the REAL RasterRenderer.render() against the WebGPU stub (no GPU)
// and intercepts `device.queue.writeBuffer` to read the 160-byte global uniform
// the renderer uploads, asserting slot 24.
//
// Fail-before: in raster-renderer.ts:314 change the `raster_color0` write from
// `[this._hueRotate, …]` to `[0, …]` (or stop threading hueRotate through
// setColorAdjust) and the θ-case assertion fails — the wiring that makes
// raster-hue-rotate actually reach the GPU is gone, caught before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { RasterRenderer } from '@xgis/map'
import { Camera } from '@xgis/map'
import { rasterUniformBytes } from '@xgis/map'

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

const W = 1024
const H = 768

// The raster global uniform is the reflect-derived 'Uniforms' buffer
// (raster-renderer.ts:117). raster_color0 is written at byte offset 96 → f32
// slot 24; its .x lane is hueRotateDeg (raster-renderer.ts:313-314). Filtering
// on the reflect-derived byte size uniquely identifies this write — the
// per-tile pooled uniforms are 48 B.
const RASTER_COLOR0_X = 24 // 96 / 4

/** Set raster-hue-rotate via setColorAdjust, run render() once, and return
 *  raster_color0.x from the captured 160-byte global-uniform write. */
function capturedHueRotate(ctx: GPUContext, hueRotateDeg: number): number {
  const UNIFORM_BYTES = rasterUniformBytes()
  const renderer = new RasterRenderer(ctx)
  // render() early-returns unless a url template is set; the global-uniform
  // write happens before any tile is loaded, so no real texture is needed.
  renderer.setUrlTemplate('https://example.invalid/{z}/{x}/{y}.png')
  // Brightness range stays at its spec no-op (0..1); only hue is exercised.
  renderer.setColorAdjust(hueRotateDeg, 0, 1, 0, 0)

  let captured = Number.NaN
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (
    buf: unknown,
    _off: number,
    data: ArrayBufferView | ArrayBuffer,
  ): void => {
    if ((buf as { size?: number })?.size !== UNIFORM_BYTES) return
    const f32 =
      data instanceof ArrayBuffer
        ? new Float32Array(data)
        : new Float32Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            40,
          )
    captured = f32[RASTER_COLOR0_X]
  }

  const camera = new Camera(10, 20, 5)
  camera.projType = 0
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.render(pass, camera, 0, 10, 20, W, H, 1)

  return captured
}

describe('raster-hue-rotate uniform wiring (GPU-free)', () => {
  it('raster_color0.x carries the authored hue-rotate degrees', async () => {
    const ctx = await makeCtx()
    // A distinctive non-default angle so the assertion is non-vacuous: this
    // can only pass if the renderer threaded THIS value into slot 24.
    expect(capturedHueRotate(ctx, 137)).toBeCloseTo(137, 5)
  })

  it('raster_color0.x = 0 for the default (un-authored) no-op', async () => {
    const ctx = await makeCtx()
    expect(capturedHueRotate(ctx, 0)).toBeCloseTo(0, 5)
  })
})
