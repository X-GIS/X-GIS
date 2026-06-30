// line-miter-limit: layer-uniform wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: line-miter-limit is
// marked `supported` in the line capability + spec-coverage, and there IS a
// unit test for the pure `packLineLayerUniform` (line-renderer.test.ts), but
// no test pins the RUNTIME wire — that LineRenderer.writeLayerSlot() actually
// threads its `miterLimit` argument through the pack into the layer-uniform
// ring buffer it uploads to the GPU. A break in writeLayerSlot's threading (or
// in the slot-7 pack write) ships silently: the pure-pack unit test still
// passes while no real miter limit reaches the shader.
//
// This drives the REAL LineRenderer.writeLayerSlot + endFrame against the
// WebGPU stub (no GPU) and intercepts `device.queue.writeBuffer` to read the
// 256-byte layer slot the renderer uploads into the layer ring, asserting
// that f32 slot [7] (LineLayerUniform.miter_limit) carries the value passed.
// Two distinct values are checked so a constant / prop-independent write can
// never pass (non-vacuous).
//
// Fail-before: change `buf[7] = miterLimit` to `buf[7] = 0` in
// line-pattern.ts (or stop threading `miterLimit` through writeLayerSlot) and
// both assertions fail — the wire that makes line-miter-limit reach the GPU
// is gone, and the test catches it before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/engine'
import { LineRenderer, LINE_CAP_BUTT, LINE_JOIN_MITER } from './line-renderer'

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

// The layer ring is `layerRingCapacity (512) * LAYER_SLOT (256)` bytes. This
// size is unique among the buffers the renderer writes, so keying the
// writeBuffer interception on it unambiguously selects the layer-uniform
// upload (endFrame()). The miter limit is f32 slot [7] of the 256-byte slot.
const LAYER_RING_BYTES = 512 * 256
const MITER_LIMIT_SLOT = 7

/** Add a single line layer with the given miterLimit, flush the layer ring,
 *  and return f32 slot [7] from the captured layer-ring upload. */
function capturedMiterLimit(ctx: GPUContext, miterLimit: number): number {
  const tileBgl = (ctx.device as unknown as {
    createBindGroupLayout: (d: unknown) => GPUBindGroupLayout
  }).createBindGroupLayout({ entries: [] })
  const renderer = new LineRenderer(ctx, tileBgl)

  let value = Number.NaN
  const device = ctx.device as unknown as {
    queue: {
      writeBuffer: (
        buf: unknown, bufferOffset: number,
        data: ArrayBuffer | ArrayBufferView, dataOffset?: number, size?: number,
      ) => void
    }
  }
  device.queue.writeBuffer = (
    buf: unknown, _bufferOffset: number,
    data: ArrayBuffer | ArrayBufferView, dataOffset = 0,
  ): void => {
    if ((buf as { size?: number })?.size !== LAYER_RING_BYTES) return
    const ab = data instanceof ArrayBuffer
      ? data
      : (data as ArrayBufferView).buffer
    const base = data instanceof ArrayBuffer
      ? dataOffset
      : (data as ArrayBufferView).byteOffset + dataOffset
    // The first layer's slot lands at ring offset 0 (dataOffset 0).
    const f32 = new Float32Array(ab, base, MITER_LIMIT_SLOT + 1)
    value = f32[MITER_LIMIT_SLOT]
  }

  // writeLayerSlot positional tail: …, cap, join, miterLimit, dash, …
  renderer.writeLayerSlot(
    [1, 0, 0, 1], // strokeColor
    3,            // strokeWidthPx
    1,            // opacity
    1000,         // mppAtCenter
    LINE_CAP_BUTT,
    LINE_JOIN_MITER,
    miterLimit,
  )
  // endFrame() flushes the dirty layer-ring range via a single writeBuffer.
  renderer.endFrame()

  return value
}

describe('line-miter-limit layer-uniform wiring (GPU-free)', () => {
  it('miter_limit slot carries 8.0 when writeLayerSlot is given 8.0', async () => {
    const ctx = await makeCtx()
    expect(capturedMiterLimit(ctx, 8.0)).toBeCloseTo(8.0, 5)
  })

  it('miter_limit slot carries 3.5 when writeLayerSlot is given 3.5 (prop-dependent, not a constant)', async () => {
    const ctx = await makeCtx()
    expect(capturedMiterLimit(ctx, 3.5)).toBeCloseTo(3.5, 5)
  })
})
