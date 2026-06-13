// Leak gate for GpuTileStore.destroy() draining the pooled-buffer recycler.
//
// THE BUG THIS PINS: destroy() tore down the per-tile cache buffers, the three
// GPUArenas, and _retiredArenaBuffers — but NEVER drained _bufferPool. The pool
// holds standalone GPUBuffers (freed tile line/index/outline buffers handed back
// by releaseBuffer, kept alive for reuse, cap 16/bucket). They are NOT arena
// slices, so arena.destroy() does not reclaim them; on teardown they were merely
// GC-dropped and their GPU memory leaked until device loss — compounding across
// SPA map create/destroy cycles.
//
// THE FIX: destroy() now iterates _bufferPool and .destroy()s every pooled
// buffer, then clears the map.
//
// HOW THIS TEST WORKS: GpuTileStore's constructor is just `this.device = device`
// (no GPU init), and acquireBuffer/releaseBuffer operate purely on the pool via
// the mock device's createBuffer. We acquire then release a handful of buffers
// (staying under the 16/bucket cap so they LAND in the pool, not destroyed),
// then destroy() and assert every pooled buffer is now destroyed.

import { describe, expect, it } from 'vitest'
import { GpuTileStore } from './gpu-tile-store'

interface MockBuffer {
  size: number
  usage: number
  label?: string
  destroyed: boolean
  destroy(): void
}

function mockDevice() {
  return {
    createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
      const b: MockBuffer = {
        size: desc.size,
        usage: desc.usage,
        label: desc.label ?? undefined,
        destroyed: false,
        destroy() { b.destroyed = true },
      }
      return b as unknown as GPUBuffer
    },
  } as unknown as GPUDevice
}

const VERTEX_USAGE = 0x20 | 0x8 // GPUBufferUsage.VERTEX | COPY_DST

describe('GpuTileStore.destroy() drains the buffer pool', () => {
  it('destroys every buffer parked in _bufferPool (no GPU leak on teardown)', () => {
    const store = new GpuTileStore(mockDevice())

    // Acquire then release a few buffers so they land in the pool. Sizes pick
    // the same power-of-two bucket so releaseBuffer's `${size}:${usage}` key
    // matches acquireBuffer's bucket key (the buffers are created at bucket size).
    const released: MockBuffer[] = []
    for (let i = 0; i < 4; i++) {
      const buf = store.acquireBuffer(1500, VERTEX_USAGE, `pooled-${i}`)
      // Under the 16/bucket cap → release parks it in the pool, NOT destroyed.
      store.releaseBuffer(buf)
      released.push(buf as unknown as MockBuffer)
    }

    // Sanity: parking in the pool must not have destroyed them yet.
    expect(released.every(b => b.destroyed === false)).toBe(true)

    store.destroy()

    // After destroy(): every pooled buffer must be destroyed (the leak fix).
    for (const b of released) {
      expect(b.destroyed).toBe(true)
    }
  })

  it('drains buffers across multiple buckets', () => {
    const store = new GpuTileStore(mockDevice())

    // 1500 → bucket 2048, 3000 → bucket 4096 — two distinct pool buckets.
    const small = store.acquireBuffer(1500, VERTEX_USAGE, 'small')
    const large = store.acquireBuffer(3000, VERTEX_USAGE, 'large')
    store.releaseBuffer(small)
    store.releaseBuffer(large)

    const smallM = small as unknown as MockBuffer
    const largeM = large as unknown as MockBuffer
    expect(smallM.destroyed).toBe(false)
    expect(largeM.destroyed).toBe(false)

    store.destroy()

    expect(smallM.destroyed).toBe(true)
    expect(largeM.destroyed).toBe(true)
  })
})
