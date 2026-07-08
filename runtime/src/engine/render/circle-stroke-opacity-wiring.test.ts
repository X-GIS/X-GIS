// circle-stroke-opacity: zoom-interpolated stroke-alpha wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: circle-stroke-opacity is
// marked `supported` in paint-circle spec-coverage + the circle capability
// table, but its RUNTIME data path was only verified structurally / on the
// compiler side. The runtime contract is: when a circle layer carries a
// zoom-interpolated circle-stroke-opacity shape, PointRenderer.updateDynamicSizes
// resolves it each frame and writes `baseStrokeAlphaSlot8 × resolved` into
// feat_data slot 8 (the stroke alpha), and render()'s uploadLayer copies slots
// 0-10 into the expanded feature buffer it uploads to the GPU. The point FS
// reads slot 8 as the stroke colour's alpha.
//
// This drives the REAL PointRenderer.addLayer + updateDynamicSizes + render()
// against the WebGPU stub (no GPU) and intercepts `device.queue.writeBuffer` to
// read the expanded feature buffer the renderer actually uploads, asserting
// slot 8 == baseStrokeAlpha × resolvedStrokeOpacity.
//
// Non-vacuous: the stroke base alpha is 1 (opaque stroke, opacity 1) and the
// stroke-opacity shape resolves to 0.4, so slot 8 must be exactly 0.4 — a value
// that comes ONLY from the prop. Break the threading (write the base unchanged,
// or drop the multiply) and slot 8 stays at 1 (or 0) and the assertion fails
// before any render.
//
// Fail-before: in updateDynamicSizes drop the `baseStrokeAlphaSlot8 *
// Math.max(0, Math.min(1, r.value))` multiply (write the base alpha unchanged)
// and the 0.4 assertion fails — the wiring that makes circle-stroke-opacity
// reach the GPU is gone, and the test catches it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { PointRenderer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import { Camera } from '@xgis/map'
import type { PropertyShape } from '@xgis/compiler'

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

// Three known points so the expanded feature buffer's byte size
// (3 × STRIDE × 4 = 288) is distinct from every other buffer the renderer
// writes for this layer (uniform 144, expanded verts 3×4×4×4 = 192, expanded
// indices 3×6×4 = 72).
const FEATURES = [
  { geometry: { type: 'Point', coordinates: [10, 20] } },
  { geometry: { type: 'Point', coordinates: [11, 21] } },
  { geometry: { type: 'Point', coordinates: [12, 22] } },
]
const N = FEATURES.length

const STRIDE = 24 // floats per point in feat_data (mirrors STRIDE)
const STROKE_ALPHA_SLOT = 8 // feat_data slot 8 = baked stroke alpha
const EXPANDED_BYTES = N * STRIDE * 4 // 288

// Opaque blue stroke (alpha 1), opacity 1 → baseStrokeAlphaSlot8 = 1*1 = 1, so
// the captured slot-8 value is exactly the resolved stroke-opacity.
const FILL: [number, number, number, number] = [1, 0, 0, 1]
const STROKE: [number, number, number, number] = [0, 0, 1, 1]

// Flat zoom-interpolated stroke-opacity: resolves to exactly 0.4 at any zoom.
const STROKE_OPACITY = 0.4
const STROKE_OPACITY_SHAPE: PropertyShape<number> = {
  kind: 'zoom-interpolated',
  stops: [
    { zoom: 0, value: STROKE_OPACITY },
    { zoom: 22, value: STROKE_OPACITY },
  ],
  base: 1,
} as unknown as PropertyShape<number>

const W = 1024
const H = 768
const ZOOM = 8

/** Add a circle layer carrying the zoom-interp stroke-opacity shape, run
 *  updateDynamicSizes (resolves the shape into feat_data slot 8) + render()
 *  once, and return slot 8 from the captured expanded-feature upload. */
function capturedStrokeAlpha(ctx: GPUContext): number {
  const renderer = new PointRenderer({
    device: ctx.device,
    format: ctx.format,
    rhi: new WebGpuDevice(ctx.device),
  })
  // addLayer positional tail: …, sizeShape, circleTranslateX, circleTranslateY,
  // circleBlur, strokeOpacityShape, … Opaque so it draws in phase 1.
  renderer.addLayer(
    FEATURES as never,
    FILL,
    STROKE,
    2,
    8,
    1,
    null,
    null,
    true,
    undefined,
    undefined,
    null,
    0,
    0,
    0,
    STROKE_OPACITY_SHAPE,
  )

  let slot8 = Number.NaN
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (
    buf: unknown,
    _off: number,
    data: ArrayBufferView | ArrayBuffer,
  ): void => {
    if ((buf as { size?: number })?.size !== EXPANDED_BYTES) return
    const f32 =
      data instanceof ArrayBuffer
        ? new Float32Array(data)
        : new Float32Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            N * STRIDE,
          )
    slot8 = f32[STROKE_ALPHA_SLOT]
  }

  // Resolve the zoom-interp stroke-opacity into feat_data slot 8.
  renderer.updateDynamicSizes(ZOOM, 0)

  const camera = new Camera(11, 21, ZOOM)
  camera.projType = 0
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.render(pass, camera, 0, 11, 21, W, H, 1)

  return slot8
}

describe('circle-stroke-opacity wiring (GPU-free)', () => {
  it('feat_data slot 8 = baseStrokeAlpha (1) × resolved stroke-opacity (0.4)', async () => {
    const ctx = await makeCtx()
    const slot8 = capturedStrokeAlpha(ctx)
    expect(Number.isNaN(slot8), 'expanded feature buffer should have been written').toBe(false)
    // Break the stroke-opacity threading (write the base alpha unchanged) and
    // slot 8 stays at 1 → this fails. Non-vacuous: 0.4 comes only from the prop.
    expect(slot8).toBeCloseTo(STROKE_OPACITY, 5)
  })
})
