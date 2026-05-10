import { describe, expect, it, beforeEach, vi } from 'vitest'

// WebGPU globals don't exist in the node test env — polyfill the tiny
// subset the pool touches. Values match the WebGPU spec.
;(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
  MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008,
  INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080,
  INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
}
;(globalThis as unknown as { GPUMapMode: Record<string, number> }).GPUMapMode = {
  READ: 0x0001, WRITE: 0x0002,
}

import { StagingBufferPool, asyncWriteBuffer } from '../engine/gpu/staging-buffer-pool'

// Mock GPU. Real WebGPU needs a browser context; the pool only uses
// `createBuffer`, `mapAsync`, `getMappedRange`, `unmap`, `destroy`, and
// `copyBufferToBuffer` on an encoder — all easy to stub.
function makeMockDevice(): GPUDevice {
  const buffers: MockBuffer[] = []
  const device = {
    createBuffer: vi.fn((desc: GPUBufferDescriptor) => {
      const b = new MockBuffer(desc.size, desc.mappedAtCreation === true)
      buffers.push(b)
      return b as unknown as GPUBuffer
    }),
  } as unknown as GPUDevice & { _buffers: MockBuffer[] }
  ;(device as { _buffers: MockBuffer[] })._buffers = buffers
  return device
}

class MockBuffer {
  size: number
  state: 'mapped' | 'unmapped' | 'destroyed' = 'unmapped'
  storage: ArrayBuffer
  destroyCalled = 0
  mapAsyncCalled = 0
  constructor(size: number, mappedAtCreation: boolean) {
    this.size = size
    this.storage = new ArrayBuffer(size)
    if (mappedAtCreation) this.state = 'mapped'
  }
  async mapAsync(_mode: number): Promise<void> {
    this.mapAsyncCalled++
    this.state = 'mapped'
  }
  getMappedRange(offset = 0, length?: number): ArrayBuffer {
    if (this.state !== 'mapped') throw new Error('not mapped')
    const len = length ?? this.size - offset
    return this.storage.slice(offset, offset + len)
  }
  unmap(): void { this.state = 'unmapped' }
  destroy(): void { this.destroyCalled++; this.state = 'destroyed' }
}

function makeMockEncoder() {
  const copies: Array<{ src: GPUBuffer; srcOff: number; dst: GPUBuffer; dstOff: number; size: number }> = []
  const encoder = {
    copyBufferToBuffer: vi.fn((src: GPUBuffer, srcOff: number, dst: GPUBuffer, dstOff: number, size: number) => {
      copies.push({ src, srcOff, dst, dstOff, size })
    }),
  } as unknown as GPUCommandEncoder & { _copies: typeof copies }
  ;(encoder as unknown as { _copies: typeof copies })._copies = copies
  return encoder
}

describe('StagingBufferPool', () => {
  let device: GPUDevice
  let pool: StagingBufferPool

  beforeEach(() => {
    device = makeMockDevice()
    pool = new StagingBufferPool(device)
  })

  it('picks the smallest tier that fits the request', async () => {
    // 100 bytes → tier 0 (4 KB). 5 KB → tier 1 (16 KB).
    const a = await pool.borrow(100)
    expect(a.byteCapacity).toBe(4 * 1024)
    expect(a.tier).toBe(0)
    const b = await pool.borrow(5 * 1024)
    expect(b.byteCapacity).toBe(16 * 1024)
    expect(b.tier).toBe(1)
  })

  it('reuses released slots from the same tier', async () => {
    const a = await pool.borrow(1000)
    pool.release(a)
    const b = await pool.borrow(1000)
    // Same buffer object — reuse, not new allocation.
    expect(b.buffer).toBe(a.buffer)
    // Created count stayed at 1.
    expect(pool.getCreatedCount()).toBe(1)
  })

  it('re-maps a released slot via mapAsync on the next borrow', async () => {
    const a = await pool.borrow(1000)
    const buf = a.buffer as unknown as MockBuffer
    // Created mappedAtCreation, so first borrow had no mapAsync call.
    expect(buf.mapAsyncCalled).toBe(0)
    pool.release(a)
    // Mock for "buffer was unmapped after caller's flow"
    buf.unmap()
    await pool.borrow(1000)
    expect(buf.mapAsyncCalled).toBe(1)
  })

  it('creates oversize one-off buffer (tier = -1), destroys on release', async () => {
    const huge = 32 * 1024 * 1024 // 32 MB > 16 MB largest tier
    const slot = await pool.borrow(huge)
    expect(slot.tier).toBe(-1)
    expect(slot.byteCapacity).toBe(huge)
    pool.release(slot)
    const buf = slot.buffer as unknown as MockBuffer
    expect(buf.destroyCalled).toBe(1)
  })

  it('asyncWriteBuffer no-ops on zero-length data (matches writeBuffer semantics)', async () => {
    const encoder = makeMockEncoder()
    const dstBuf = { _name: 'dst' } as unknown as GPUBuffer
    const handle = await asyncWriteBuffer(pool, encoder, dstBuf, 0, new Uint8Array(0))
    handle.release() // no-op release returned, must not throw
    const copies = (encoder as unknown as { _copies: Array<unknown> })._copies
    expect(copies.length).toBe(0) // no copyBufferToBuffer emitted
    // No staging buffer should have been allocated.
    const created = (device as unknown as { _buffers: MockBuffer[] })._buffers
    expect(created.length).toBe(0)
  })

  it('asyncWriteBuffer copies data and emits copyBufferToBuffer', async () => {
    const encoder = makeMockEncoder()
    const dst = (device as unknown as { _buffers: MockBuffer[] })._buffers
    // Synthesize a destination buffer (we won't use the pool for it).
    const dstBuf = { _name: 'dst' } as unknown as GPUBuffer
    const data = new Uint8Array([1, 2, 3, 4, 5])
    const handle = await asyncWriteBuffer(pool, encoder, dstBuf, 0, data)
    handle.release()

    const copies = (encoder as unknown as { _copies: Array<{ size: number; dst: unknown }> })._copies
    expect(copies.length).toBe(1)
    expect(copies[0].size).toBe(5)
    expect(copies[0].dst).toBe(dstBuf)
    // dst array is unrelated to mock-device buffer list; use length to
    // confirm staging buffer was created on borrow.
    expect(dst.length).toBe(1)
  })
})
