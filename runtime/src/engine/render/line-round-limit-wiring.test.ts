// line-round-limit: per-layer round-join fold-threshold wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: line-round-limit is
// marked `supported` (constant) in the line capability table
// (runtime/src/capabilities/line.ts) and its only runtime coverage was the
// architecture-invariants line-count bump + the WGSL-compile smoke — neither
// would catch a BROKEN DATA PATH where show.roundLimit stops being threaded
// into the line layer uniform the renderer actually uploads.
//
// The runtime contract (packLineLayerUniform / line-pattern.ts:293):
//   buf[49] = roundLimit                 // f32 slot 49 (byte 196)
// The line VS reads layer.field('round_limit') and, when > 0, scales the
// round-join acute-fold threshold by round_limit / 1.05 (shader-dsl line.ts).
//
// This drives the REAL LineRenderer.writeLayerSlot + endFrame() against a
// minimal GPU-free fake device (mirrors line-renderer-layer-ring.test.ts) and
// intercepts the single batched `device.queue.writeBuffer` flush to read the
// staged 256-byte layer slot, asserting f32 slot 49 carries roundLimit.
//
// Fail-before: drop `buf[49] = roundLimit` (write 0 / a constant) in
// line-pattern.ts, or stop threading roundLimit through writeLayerSlot →
// packLineLayerUniform, and the positive-value assertion fails — the wiring
// that makes line-round-limit reach the GPU is gone, caught before any render.

import { describe, expect, it } from 'vitest'
// WebGPU globals don't exist under happy-dom — stub the few constants
// LineRenderer touches in its constructor (mirrors line-renderer-layer-ring.test.ts).
;(globalThis as unknown as { GPUShaderStage: { VERTEX: number; FRAGMENT: number } }).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 }
;(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
  UNIFORM: 1, COPY_DST: 2, STORAGE: 4, VERTEX: 8, INDEX: 16,
}
import { LineRenderer } from './line-renderer'
import { lineLayerUniformStride } from './line-uniform-slots'
import { WebGpuDevice } from './rhi/rhi-webgpu'
import type { GPUContext } from '../gpu/gpu'

// f32 slot 49 (byte 196) of the 256-byte line layer slot is line-round-limit.
// See line-pattern.ts:293 (`buf[49] = roundLimit`) and the line.ts WGSL
// `round_limit` field comment.
const ROUND_LIMIT_SLOT = 49

interface Flush {
  /** ArrayBuffer staged for the layerRing flush. */
  buffer: ArrayBuffer
  /** dataOffset arg of writeBuffer (byteOffset + lo). */
  dataOffset: number
  /** size arg of writeBuffer. */
  size: number
}

/** Build a minimal GPU-free LineRenderer and a writeBuffer spy that records
 *  the single batched endFrame() flush (mirrors line-renderer-layer-ring.test.ts). */
function makeRenderer(): { lr: LineRenderer; flushes: Flush[] } {
  const flushes: Flush[] = []
  const fakeBuffer = {} as GPUBuffer
  const fakeDevice = {
    createBuffer: () => fakeBuffer,
    createBindGroup: () => ({}) as GPUBindGroup,
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createRenderPipeline: () => ({}) as GPURenderPipeline,
    createShaderModule: () => ({}) as GPUShaderModule,
    createSampler: () => ({}) as GPUSampler,
    createTexture: () => ({ createView: () => ({}) }) as unknown as GPUTexture,
    queue: {
      writeBuffer: (
        _buf: GPUBuffer, _offset: number, data: ArrayBufferView | ArrayBuffer,
        dataOffset = 0, size?: number,
      ) => {
        const ab = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer
        const baseOff = data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset
        const byteLen = size ?? (data instanceof ArrayBuffer
          ? data.byteLength
          : (data as ArrayBufferView).byteLength)
        flushes.push({ buffer: ab as ArrayBuffer, dataOffset: baseOff + dataOffset, size: byteLen })
      },
    },
  }
  const lr = new LineRenderer(
    { device: fakeDevice as unknown as GPUDevice, format: 'bgra8unorm', canvas: {} as HTMLCanvasElement, context: {} as GPUCanvasContext, rhi: new WebGpuDevice(fakeDevice as unknown as GPUDevice) } as unknown as GPUContext,
    {} as GPUBindGroupLayout,
  )
  return { lr, flushes }
}

/** Stage a single line layer with the given roundLimit, flush, and read f32
 *  slot 49 of its 256-byte layer slot from the captured staging bytes. */
function capturedRoundLimit(roundLimit: number): number {
  const { lr, flushes } = makeRenderer()
  // writeLayerSlot positional tail: …, lineTranslateX, lineTranslateY, roundLimit.
  lr.writeLayerSlot(
    [1, 0, 0, 1], // strokeColor
    4,            // strokeWidthPx
    1,            // opacity
    1,            // mppAtCenter
    0, 0, 2.0,    // cap, join, miterLimit
    null, [], 0, 1, // dash, patterns, offsetPx, viewportHeight
    0, 1,         // blurPx, dpr
    0, 0,         // lineTranslateX, lineTranslateY
    roundLimit,   // line-round-limit
  )
  lr.endFrame()
  expect(flushes, 'endFrame() should flush exactly one layer-ring write').toHaveLength(1)
  const f = flushes[0]
  // First (and only) slot starts at flush offset 0 within the staging buffer.
  // Slot stride DERIVED from reflect (lineLayerUniformStride, the SAME source the
  // LineRenderer ring uses) — not a hardcoded 256 that drifts when LineLayer grows.
  const slotByteBase = f.dataOffset
  const f32 = new Float32Array(f.buffer, slotByteBase, lineLayerUniformStride() / 4)
  return f32[ROUND_LIMIT_SLOT]
}

describe('line-round-limit layer-uniform wiring (GPU-free)', () => {
  it('round_limit slot 49 carries show.roundLimit when authored', () => {
    // Break `buf[49] = roundLimit` (→ 0 / a constant) and this fails.
    expect(capturedRoundLimit(1.05)).toBeCloseTo(1.05, 5)
  })

  it('round_limit slot 49 reflects a distinct authored value (non-constant)', () => {
    // A second, different value proves the slot tracks the PROP, not a constant.
    expect(capturedRoundLimit(3.5)).toBeCloseTo(3.5, 5)
  })

  it('round_limit slot 49 = 0 when unset (byte-identical historical-fold default)', () => {
    expect(capturedRoundLimit(0)).toBe(0)
  })
})
