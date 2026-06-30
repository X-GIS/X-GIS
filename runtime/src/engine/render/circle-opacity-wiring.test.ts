// circle-opacity: per-feature alpha wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: circle-opacity is
// marked `supported` in compiler/src/convert/spec-coverage/paint-circle.ts
// (Mapbox 0..1 → xgis 0..100 → the `opacity` multiplier), but its runtime
// contract was only covered structurally. circle-opacity lowers through the
// converter (layers-circle.ts) into the `opacity-N` className, which map.ts
// lexes and threads into PointRenderer.addLayer's `opacity` argument. The
// renderer bakes it into the per-feature data buffer: the fill-alpha lands at
// STRIDE slot 4 (= fill[3] * opacity) and the stroke-alpha at slot 8
// (= stroke[3] * opacity). The point fragment shader reads these as the
// drawn opacity of the circle fill/stroke.
//
// This drives the REAL PointRenderer.addLayer against the WebGPU stub (no
// GPU) and intercepts `device.queue.writeBuffer` to read the 96-byte
// per-feature buffer (1 point × STRIDE 24 × 4 B) the renderer uploads,
// asserting slot 4 == fill[3]*opacity and slot 8 == stroke[3]*opacity.
//
// Fail-before: replace the `* opacity` factor in the slot-4/slot-8 writes
// with a constant (e.g. `* 1`) and both assertions fail — the wiring that
// makes circle-opacity actually reach the GPU is gone, and the test catches
// it before any render. The assertions are prop-dependent (they reference
// OPACITY, not a constant), so they cannot pass vacuously.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/engine'
import { PointRenderer } from './point-renderer'
import { WebGpuDevice } from '@xgis/engine'

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

// Single point → the per-feature feat_data buffer is STRIDE(24) × 4 B = 96 B,
// distinct from the vertices (4 verts × 4 floats × 4 B = 64 B) and indices
// (6 × 4 B = 24 B) addLayer also writes, so the size key is unambiguous.
const STRIDE = 24
const FILL_ALPHA_SLOT = 4
const STROKE_ALPHA_SLOT = 8
const FEAT_BYTES = STRIDE * 4 // 96

const FEATURES = [{ geometry: { type: 'Point', coordinates: [10, 20] } }]
// Both colours fully opaque so the captured alpha is exactly the layer opacity.
const FILL: [number, number, number, number] = [1, 0, 0, 1]
const STROKE: [number, number, number, number] = [0, 0, 1, 1]
const STROKE_WIDTH = 1
const RADIUS_PX = 8
const OPACITY = 0.5 // circle-opacity 0.5

/** Add one circle layer with the given opacity and return the per-feature
 *  feat_data the renderer uploads, captured by intercepting writeBuffer
 *  keyed on the 96-byte feature-buffer size. */
function capturedFeatData(ctx: GPUContext, opacity: number): Float32Array | undefined {
  let feat: Float32Array | undefined
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (buf: unknown, _off: number, data: ArrayBufferView | ArrayBuffer): void => {
    if ((buf as { size?: number })?.size !== FEAT_BYTES) return
    feat = data instanceof ArrayBuffer
      ? new Float32Array(data)
      : new Float32Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, STRIDE)
  }

  const renderer = new PointRenderer({ device: ctx.device, format: ctx.format, rhi: new WebGpuDevice(ctx.device) })
  // addLayer(features, fill, stroke, strokeWidth, radiusPx, opacity, …)
  renderer.addLayer(FEATURES as never, FILL, STROKE, STROKE_WIDTH, RADIUS_PX, opacity)
  return feat
}

describe('circle-opacity per-feature alpha wiring (GPU-free)', () => {
  it('fill alpha (slot 4) == fill[3] * circle-opacity', async () => {
    const ctx = await makeCtx()
    const feat = capturedFeatData(ctx, OPACITY)
    expect(feat, 'point feature buffer (96 B) should have been written').toBeTruthy()
    // Break `* opacity` → constant and this fails (FILL[3]*OPACITY = 0.5).
    expect(feat![FILL_ALPHA_SLOT]).toBeCloseTo(FILL[3] * OPACITY, 5)
  })

  it('stroke alpha (slot 8) == stroke[3] * circle-opacity', async () => {
    const ctx = await makeCtx()
    const feat = capturedFeatData(ctx, OPACITY)
    expect(feat, 'point feature buffer (96 B) should have been written').toBeTruthy()
    expect(feat![STROKE_ALPHA_SLOT]).toBeCloseTo(STROKE[3] * OPACITY, 5)
  })

  it('opacity threads through: alpha tracks the prop, not a constant', async () => {
    const ctx = await makeCtx()
    const a = capturedFeatData(ctx, 0.25)
    const b = capturedFeatData(ctx, 0.75)
    expect(a, 'feat (opacity 0.25)').toBeTruthy()
    expect(b, 'feat (opacity 0.75)').toBeTruthy()
    expect(a![FILL_ALPHA_SLOT]).toBeCloseTo(FILL[3] * 0.25, 5)
    expect(b![FILL_ALPHA_SLOT]).toBeCloseTo(FILL[3] * 0.75, 5)
    // Distinct opacities → distinct baked alpha: proves the prop is the source.
    expect(a![FILL_ALPHA_SLOT]).not.toBeCloseTo(b![FILL_ALPHA_SLOT], 5)
  })
})
