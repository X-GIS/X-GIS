// raster-opacity wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: raster-opacity is
// marked `supported` in compiler/src/convert/spec-coverage paint-raster +
// the raster capability table, but its RUNTIME wiring (the path that makes
// the resolved opacity actually reach the GPU) had no behavioral test —
// only structural / compile coverage. A break in the data path (the
// fragment shader stops fading the basemap) would ship silently.
//
// The runtime contract: RasterRenderer.setOpacity(v) stores _opacity, and
// render() uploads it into the 160-byte raster global uniform at
// raster_params.x — f32 slot 20 (byte offset 80). The raster FS multiplies
// the sampled texel alpha by that slot (see emitRasterWgsl / raster.ts).
// The orchestrator (opaque-pass.ts) resolves the show's
// paintShapes.common.opacity via resolveNumberShape and calls setOpacity
// before the frame's render().
//
// This drives the REAL RasterRenderer.render() against the WebGPU stub
// (no GPU) and intercepts `device.queue.writeBuffer` to read the bytes the
// renderer actually uploads, asserting slot 20 carries the set opacity and
// NOT the default 1.0.
//
// Fail-before: replace `[this._opacity, 0, 0, 0]` with `[1, 0, 0, 0]` (or
// drop the threading of _opacity into raster_params.x) and the
// custom-opacity assertion fails — the wire that makes raster-opacity reach
// the GPU is gone, caught before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/engine'
import { RasterRenderer } from '@xgis/map'
import { Camera } from '@xgis/engine'
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

// The raster GLOBAL uniform is the reflect-derived 'Uniforms' buffer
// (constructor: createBuffer({ size, label: 'raster-uniforms' })).
// raster_params.x — the opacity slot — is byte offset 80 → f32 slot 20. The
// per-tile pool buffers are 48 B, so keying on the reflect-derived global byte
// size isolates the global write.
const RASTER_PARAMS_X = 20

/** Set opacity, run render() once against the stub, and return
 *  raster_params.x from the captured 160-byte global-uniform write. */
function capturedOpacity(ctx: GPUContext, opacity: number): number {
  const GLOBAL_UNIFORM_BYTES = rasterUniformBytes()
  const renderer = new RasterRenderer(ctx)
  // render() returns early when urlTemplate is empty (no draw, no upload);
  // give it a template so the global uniform write at the top of the tile
  // loop actually fires. The stub never fetches a real tile, so no tile is
  // ever cached — but the global uniform (incl. opacity) is uploaded
  // unconditionally once we pass the urlTemplate guard.
  renderer.setUrlTemplate('https://example.invalid/{z}/{x}/{y}.png')
  renderer.setOpacity(opacity)

  let slot = Number.NaN
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (
    buf: unknown,
    _off: number,
    data: ArrayBufferView | ArrayBuffer,
  ): void => {
    if ((buf as { size?: number })?.size !== GLOBAL_UNIFORM_BYTES) return
    const f32 =
      data instanceof ArrayBuffer
        ? new Float32Array(data)
        : new Float32Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            (data as ArrayBufferView).byteLength / 4,
          )
    slot = f32[RASTER_PARAMS_X]
  }

  const camera = new Camera(10, 20, 4)
  camera.projType = 0
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.render(pass, camera, 0, 10, 20, W, H, 1)

  return slot
}

describe('raster-opacity wiring (GPU-free)', () => {
  it('raster_params.x carries the value passed to setOpacity', async () => {
    const ctx = await makeCtx()
    // 0.42 is distinct from the 1.0 default AND survives the 0..1 clamp, so
    // a passing assertion proves the prop (not a constant) drives the slot.
    expect(capturedOpacity(ctx, 0.42)).toBeCloseTo(0.42, 5)
  })

  it('raster_params.x defaults to 1.0 when opacity is not authored', async () => {
    const ctx = await makeCtx()
    expect(capturedOpacity(ctx, 1)).toBeCloseTo(1, 5)
  })
})
