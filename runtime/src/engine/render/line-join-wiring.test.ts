import { describe, expect, it } from 'vitest'
// WebGPU globals don't exist under happy-dom — stub the few constants
// LineRenderer touches in its constructor. (Mirrors
// line-renderer-layer-ring.test.ts, the GPU-free layer-ring harness.)
;(globalThis as unknown as { GPUShaderStage: { VERTEX: number; FRAGMENT: number } }).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 }
;(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
  UNIFORM: 1, COPY_DST: 2, STORAGE: 4, VERTEX: 8, INDEX: 16,
}
import {
  LineRenderer,
  LINE_JOIN_MITER, LINE_JOIN_ROUND, LINE_JOIN_BEVEL,
} from './line-renderer'
import { WebGpuDevice } from './rhi/rhi-webgpu'
import type { GPUContext } from '../gpu/gpu'

// line-join: layout-property wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: `line-join` is marked
// `supported` (miter/round/bevel literal) in the line capability table, but
// the only coverage was structural (the capability row) + the WGSL-compile
// smoke. Neither would catch a BROKEN DATA PATH where the join style stops
// being threaded into the GPU layer uniform.
//
// The runtime contract (line-pattern.ts packFlags / packLineLayerUniform):
// the per-layer line uniform's `flags` word lives at u32 index 8 (byte 32),
// and the join style occupies bits 3-4 — `((join & 3) << 3)`. The line
// fragment/vertex shader reads those bits to select the miter / round / bevel
// join geometry. VTR computes `join = joinMap[show.linejoin]` and passes it as
// the 6th positional arg of `lineRenderer.writeLayerSlot(...)`.
//
// This drives the REAL LineRenderer.writeLayerSlot + endFrame against a fake
// device (no GPU) and intercepts `queue.writeBuffer` to read the bytes the
// renderer actually uploads, then extracts join bits 3-4 from the flags word.
//
// Fail-before: break the join packing (e.g. `((join & 3) << 3)` → `(0 << 3)`)
// and the round + bevel assertions go red — the wire that makes `line-join`
// reach the GPU is gone, and the test catches it before any render.

// flags word offset inside the per-layer uniform (u32 index 8 = byte 32),
// and the join bit position (bits 3-4). Mirrors line-pattern.ts packFlags.
const FLAGS_U32_INDEX = 8
const JOIN_SHIFT = 3
const JOIN_MASK = 3

function makeLineRenderer(captured: { bytes?: ArrayBuffer; dataOffset?: number }): LineRenderer {
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
        dataOffset?: number, _size?: number,
      ) => {
        // endFrame() flushes the staging Uint8Array's backing buffer.
        captured.bytes = (data as ArrayBufferView).buffer ?? (data as ArrayBuffer)
        captured.dataOffset = dataOffset ?? 0
      },
    },
  }
  return new LineRenderer(
    { device: fakeDevice as unknown as GPUDevice, format: 'bgra8unorm', canvas: {} as HTMLCanvasElement, context: {} as GPUCanvasContext, rhi: new WebGpuDevice(fakeDevice as unknown as GPUDevice) } as unknown as GPUContext,
    {} as GPUBindGroupLayout,
  )
}

/** Stage a single line layer slot with the given join id, flush, and return
 *  the join bits (3-4) extracted from the uploaded flags word. */
function capturedJoinBits(join: number): number {
  const captured: { bytes?: ArrayBuffer; dataOffset?: number } = {}
  const lr = makeLineRenderer(captured)
  // writeLayerSlot positional tail: strokeColor, strokeWidthPx, opacity,
  // mppAtCenter, cap, JOIN, miterLimit, …
  lr.writeLayerSlot([1, 0, 0, 1], 4, 1, 1, /* cap */ 0, join)
  lr.endFrame()
  expect(captured.bytes, 'endFrame() should have flushed the layer ring via writeBuffer').toBeTruthy()
  // The flush covers the single slot starting at the buffer's dataOffset.
  const u32 = new Uint32Array(captured.bytes!, captured.dataOffset!, FLAGS_U32_INDEX + 1)
  const flags = u32[FLAGS_U32_INDEX]
  return (flags >> JOIN_SHIFT) & JOIN_MASK
}

describe('line-join layout-property wiring (GPU-free)', () => {
  it('join=miter packs 0 into flags bits 3-4', () => {
    expect(capturedJoinBits(LINE_JOIN_MITER)).toBe(0)
  })

  it('join=round packs 1 into flags bits 3-4', () => {
    // Break `((join & 3) << 3)` → `(0 << 3)` and this fails.
    expect(capturedJoinBits(LINE_JOIN_ROUND)).toBe(1)
  })

  it('join=bevel packs 2 into flags bits 3-4', () => {
    // Break the join wiring and this fails too — non-vacuous: the asserted
    // bits track the prop, not a constant.
    expect(capturedJoinBits(LINE_JOIN_BEVEL)).toBe(2)
  })
})
