import { describe, expect, it } from 'vitest'
// WebGPU globals don't exist under happy-dom — stub the few constants
// LineRenderer touches in its constructor.
;(globalThis as unknown as { GPUShaderStage: { VERTEX: number; FRAGMENT: number } }).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 }
;(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
  UNIFORM: 1, COPY_DST: 2, STORAGE: 4, VERTEX: 8, INDEX: 16,
}
import { LineRenderer, LINE_UNIFORM_SIZE, packLineLayerUniform } from '../engine/line-renderer'

// These tests validate the ring-buffer math and the public guarantees of
// the dynamic-offset layer ring without spinning up a real WebGPU device.
// They are the last line of defense against a regression where two layers
// sharing a source silently stomp each other's uniforms inside a single
// command submission.

describe('LineRenderer layer uniform ring', () => {
  it('packLineLayerUniform emits a LINE_UNIFORM_SIZE payload', () => {
    const data = packLineLayerUniform([1, 0, 0, 1], 4, 1, 1)
    expect(data.byteLength).toBe(LINE_UNIFORM_SIZE)
  })

  it('writeLayerSlot returns distinct, 256-aligned offsets per call', () => {
    // Fake GPU device — record writeBuffer offsets only.
    const writes: { offset: number; byteLen: number }[] = []
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
          _buf: GPUBuffer, offset: number, data: ArrayBufferView | ArrayBuffer,
          _dataOffset?: number, size?: number,
        ) => {
          const byteLen = size ?? (
            'byteLength' in (data as object) ? (data as ArrayBuffer).byteLength : 0
          )
          writes.push({ offset, byteLen })
        },
      },
    }
    const lr = new LineRenderer(
      { device: fakeDevice as unknown as GPUDevice, format: 'bgra8unorm', canvas: {} as HTMLCanvasElement, context: {} as GPUCanvasContext },
      {} as GPUBindGroupLayout,
    )

    const a = lr.writeLayerSlot([1, 0, 0, 1], 2, 1, 1)
    const b = lr.writeLayerSlot([0, 1, 0, 1], 3, 1, 1)
    const c = lr.writeLayerSlot([0, 0, 1, 1], 4, 1, 1)
    expect(a).toBe(0)
    expect(b).toBe(256)
    expect(c).toBe(512)
    // After batching: three writeLayerSlot calls now stage into a CPU
    // mirror without issuing any GPU writes. The flush happens in
    // endFrame() just before queue.submit. Assertion on the offsets
    // still validates the ring math; writeBuffer spy should see zero
    // calls until flush.
    expect(writes).toHaveLength(0)
    lr.endFrame()
    // Flush writes one contiguous range covering all 3 slots.
    expect(writes).toHaveLength(1)
    expect(writes[0].offset).toBe(0)
    expect(writes[0].byteLen).toBe(3 * 256)

    lr.beginFrame()
    const d = lr.writeLayerSlot([1, 1, 1, 1], 1, 1, 1)
    expect(d).toBe(0) // beginFrame() resets slot cursor
    lr.endFrame()
    // Second frame flushes only its own staged slot.
    expect(writes).toHaveLength(2)
    expect(writes[1].offset).toBe(0)
    expect(writes[1].byteLen).toBe(256)
  })
})
