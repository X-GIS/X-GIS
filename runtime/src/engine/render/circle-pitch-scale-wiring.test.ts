// circle-pitch-scale: 'map' flag wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: circle-pitch-scale is
// marked `supported` (constant) in paint-circle spec-coverage + the circle
// capability table, but was verified only STRUCTURALLY. The runtime contract
// is: when a circle layer is added with circlePitchScaleMap=true, the point
// frame uniform's circle_params.w (f32 slot 35) carries 1; otherwise 0. The
// point VS reads that flag to foreshorten the quad with pitch (Phase S B3).
//
// This drives the REAL PointRenderer.addLayer + render() against the WebGPU
// stub (no GPU) and intercepts `device.queue.writeBuffer` to read the
// 144-byte point uniform the renderer uploads, asserting slot 35.
//
// Fail-before: drop `uf[35] = circlePitchScaleMap ? 1 : 0` (or stop threading
// layer.circlePitchScaleMap into writePointFrameUniform) and the map-case
// assertion fails — the wiring that makes circle-pitch-scale 'map' actually
// reach the GPU is gone, and the test catches it before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/engine'
import { PointRenderer, pointUniformBytes } from './point-renderer'
import { WebGpuDevice } from '@xgis/engine'
import { Camera } from '@xgis/engine'

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
const W = 1024
const H = 768

// The point uniform buffer size is DERIVED from reflect() (pointUniformBytes(),
// the SAME source the renderer sizes it from), not a hardcoded 160 that drifts
// when the struct grows (#600 grew it 144→160 for globe_eye). circle_params.w is
// f32 slot 35, unchanged — globe_eye is appended AFTER circle_params. (See
// point-uniform-layout.test.ts.) Read lazily inside the function (post-setup).
const CIRCLE_PARAMS_W = 35

/** Add a single opaque circle layer with the given pitch-scale mode, run
 *  render() once, and return circle_params.w from the captured point uniform
 *  write. */
function capturedPitchScaleFlag(ctx: GPUContext, pitchScaleMap: boolean): number {
  const renderer = new PointRenderer({ device: ctx.device, format: ctx.format, rhi: new WebGpuDevice(ctx.device) })
  // addLayer positional tail: …, circleTranslateXShape, circleTranslateYShape,
  // circlePitchScaleMap. Opaque (fill α = 1, opacity 1) so it draws in phase 1.
  renderer.addLayer(
    FEATURES as never,
    FILL, null, 0, 8, 1,
    null, null, true, undefined, undefined,
    null, 0, 0, 0,
    null, null, null,
    pitchScaleMap,
  )

  const UNIFORM_BYTES = pointUniformBytes()
  const SLOT_COUNT = UNIFORM_BYTES / 4
  let flag = Number.NaN
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (buf: unknown, _off: number, data: ArrayBufferView | ArrayBuffer): void => {
    if ((buf as { size?: number })?.size !== UNIFORM_BYTES) return
    const f32 = data instanceof ArrayBuffer
      ? new Float32Array(data)
      : new Float32Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, SLOT_COUNT)
    flag = f32[CIRCLE_PARAMS_W]
  }

  const camera = new Camera(10, 20, 8)
  camera.projType = 0
  const encoder = (ctx.device as unknown as {
    createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
  }).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.render(pass, camera, 0, 10, 20, W, H, 1)

  return flag
}

describe('circle-pitch-scale map flag wiring (GPU-free)', () => {
  it('circle_params.w = 1 when circlePitchScaleMap=true', async () => {
    const ctx = await makeCtx()
    expect(capturedPitchScaleFlag(ctx, true)).toBe(1)
  })

  it('circle_params.w = 0 when circlePitchScaleMap=false (default viewport)', async () => {
    const ctx = await makeCtx()
    expect(capturedPitchScaleFlag(ctx, false)).toBe(0)
  })
})
