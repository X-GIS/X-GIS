// circle-stroke-color: stroke RGB data-path wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: circle-stroke-color is
// marked `supported` (constant + zoom-interp) in the circle capability table
// (runtime/src/capabilities/circle.ts) + paint-circle spec-coverage, but the
// only runtime coverage was structural — nothing asserted the colour actually
// reaches the GPU. The runtime contract is: PointRenderer.addLayer takes a
// parsed stroke colour [r,g,b,a] and threads its RGB into the per-feature
// feat_data buffer at slots 5/6/7 (slot 8 is alpha × opacity); the point
// shader reads those slots to paint the stroke ring. A wiring break there
// ships a silent "supported but does nothing" prop (the heatmap-class bug).
//
// This drives the REAL PointRenderer.addLayer against the WebGPU stub (no GPU)
// and intercepts `device.queue.writeBuffer` to read the per-feature feat_data
// the renderer uploads (the 'point-features' STORAGE buffer), asserting that
// slots 5/6/7 carry the exact stroke RGB for every point. It is non-vacuous:
// the asserted bytes equal the input colour, not a constant — drive a
// different colour and the assertion would track it.
//
// Fail-before: zero the stroke-RGB writes (featData[off+5..7] = 0) and the
// RGB assertions fail — the wiring that makes circle-stroke-color actually
// reach the GPU is gone, and this test catches it before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '../../gpu/gpu'
import { PointRenderer } from '../point-renderer'

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

// Three distinct points → the per-feature feat_data buffer is N*STRIDE*4 =
// 3*24*4 = 288 bytes, distinct from every other buffer addLayer writes
// (verts 192, indices 72), so keying writeBuffer by byte-size is unambiguous.
const FEATURES = [
  { geometry: { type: 'Point', coordinates: [10, 20] } },
  { geometry: { type: 'Point', coordinates: [11, 21] } },
  { geometry: { type: 'Point', coordinates: [12, 22] } },
]
const N = FEATURES.length

// feat_data stride (floats per point) — mirrors STRIDE in point-renderer.ts.
// stroke RGB @slots 5/6/7, stroke alpha @slot 8.
const STRIDE = 24
const STROKE_R = 5
const STROKE_G = 6
const STROKE_B = 7

// A deliberately distinct, non-trivial stroke colour so the assertion tracks
// the INPUT (non-vacuous), not any constant. Fill is a different colour.
const FILL: [number, number, number, number] = [1, 0, 0, 1]
const STROKE: [number, number, number, number] = [0.2, 0.4, 0.6, 1]
const STROKE_WIDTH = 2
const RADIUS = 8
const OPACITY = 1

/** Drive addLayer once and capture the per-feature feat_data the renderer
 *  uploads, keyed by its (point-features) byte size. */
function captureFeatData(ctx: GPUContext): Float32Array | undefined {
  let feat: Float32Array | undefined
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  const orig = device.queue.writeBuffer
  device.queue.writeBuffer = (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer): void => {
    if ((buf as { size?: number })?.size === N * STRIDE * 4) {
      const f32 = data instanceof ArrayBuffer
        ? new Float32Array(data)
        : new Float32Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset,
            (data as ArrayBufferView).byteLength / 4)
      feat = f32.slice(0, N * STRIDE)
    }
    orig.call(device.queue, buf, off, data)
  }

  const renderer = new PointRenderer({ device: ctx.device, format: ctx.format })
  // Positional: features, fill, stroke, strokeWidth, radiusPx, opacity, …
  renderer.addLayer(FEATURES as never, FILL, STROKE, STROKE_WIDTH, RADIUS, OPACITY)
  return feat
}

describe('circle-stroke-color stroke-RGB wiring (GPU-free)', () => {
  it('feat_data slots 5/6/7 carry the parsed stroke colour for every point', async () => {
    const ctx = await makeCtx()
    const feat = captureFeatData(ctx)
    expect(feat, 'point-features feat_data buffer should have been written').toBeTruthy()
    for (let i = 0; i < N; i++) {
      const off = i * STRIDE
      // Break the stroke-RGB threading (featData[off+5..7] = 0) → these fail.
      expect(feat![off + STROKE_R]).toBeCloseTo(STROKE[0], 5)
      expect(feat![off + STROKE_G]).toBeCloseTo(STROKE[1], 5)
      expect(feat![off + STROKE_B]).toBeCloseTo(STROKE[2], 5)
    }
  })

  it('a null stroke writes 0 RGB (so the wiring is colour-driven, not constant)', async () => {
    const ctx = await makeCtx()
    let feat: Float32Array | undefined
    const device = ctx.device as unknown as {
      queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
    }
    const orig = device.queue.writeBuffer
    device.queue.writeBuffer = (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer): void => {
      if ((buf as { size?: number })?.size === N * STRIDE * 4) {
        const f32 = data instanceof ArrayBuffer
          ? new Float32Array(data)
          : new Float32Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset,
              (data as ArrayBufferView).byteLength / 4)
        feat = f32.slice(0, N * STRIDE)
      }
      orig.call(device.queue, buf, off, data)
    }
    const renderer = new PointRenderer({ device: ctx.device, format: ctx.format })
    renderer.addLayer(FEATURES as never, FILL, null, STROKE_WIDTH, RADIUS, OPACITY)
    expect(feat, 'point-features feat_data buffer should have been written').toBeTruthy()
    for (let i = 0; i < N; i++) {
      const off = i * STRIDE
      expect(feat![off + STROKE_R]).toBe(0)
      expect(feat![off + STROKE_G]).toBe(0)
      expect(feat![off + STROKE_B]).toBe(0)
    }
  })
})
