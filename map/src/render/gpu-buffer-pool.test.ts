// ═══ GpuBufferPool liveness guards (#2248, ownership P0 — audit F-2) ═══
//
// Two paid-for hazard classes, both formerly silent:
//
// 1. RELEASE AFTER DESTROY (the audit's F-2, CONFIRMED live leak): the pool is
//    destroyed inside GpuTileStore.destroy() while the device lives on (a
//    setSourceData swap). An async upload suspended across that teardown
//    resumes, takes the coordinator's bail path, and hands its line buffers
//    back via releaseBuffer — which re-parked them into a dead free-list no
//    acquire or destroy would ever visit again: leaked until device loss.
//    StagingBufferPool got the terminal latch for exactly this shape in
//    #1153 P2 R1; this pool was the missed sibling.
//
// 2. DOUBLE-RELEASE: parking the same GPUBuffer twice hands it to two later
//    acquires — two tiles silently aliasing one buffer.
//
// Harness: the pool's own `BufferPoolDevice` seam — no GPU needed.

import { describe, it, expect } from 'vitest'
import { GpuBufferPool, type BufferPoolDevice } from './gpu-buffer-pool'

interface StubBuffer {
  size: number
  usage: number
  destroyed: boolean
  destroy(): void
}

function stubDevice(): BufferPoolDevice & { created: StubBuffer[] } {
  const created: StubBuffer[] = []
  return {
    created,
    createBuffer(desc: GPUBufferDescriptor) {
      const b: StubBuffer = {
        size: desc.size,
        usage: desc.usage,
        destroyed: false,
        destroy() {
          this.destroyed = true
        },
      }
      created.push(b)
      return b as unknown as GPUBuffer
    },
  }
}

const USAGE = 0x28 // arbitrary flag combo; the pool only keys on it

describe('GpuBufferPool — terminal latch + double-release guard (#2248)', () => {
  it('normal reuse cycle stays legal: acquire → release → acquire (same buffer) → release', () => {
    const pool = new GpuBufferPool(stubDevice())
    const b = pool.acquire(1000, USAGE, 't')
    pool.release(b)
    expect(pool.bytes).toBeGreaterThan(0)
    const again = pool.acquire(1000, USAGE, 't')
    expect(again, 'pool hit returns the parked buffer').toBe(b)
    expect(pool.bytes).toBe(0)
    // Releasing it after re-acquiring is the normal cycle — must not throw.
    expect(() => pool.release(again)).not.toThrow()
  })

  it('double-release throws — the second park would alias two later acquires', () => {
    const pool = new GpuBufferPool(stubDevice())
    const b = pool.acquire(1000, USAGE, 't')
    pool.release(b)
    expect(() => pool.release(b)).toThrow(/double-release/)
  })

  it('release after destroy() destroys the buffer instead of parking it (F-2)', () => {
    const pool = new GpuBufferPool(stubDevice())
    const b = pool.acquire(1000, USAGE, 't')
    pool.destroy()
    pool.release(b)
    expect((b as unknown as StubBuffer).destroyed, 'destroyed, not parked').toBe(true)
    expect(pool.bytes, 'nothing parked into the dead pool').toBe(0)
    // A later acquire must NOT be served the dead buffer.
    const fresh = pool.acquire(1000, USAGE, 't')
    expect(fresh).not.toBe(b)
  })

  it('destroy() destroys every parked buffer and is the terminal state', () => {
    const dev = stubDevice()
    const pool = new GpuBufferPool(dev)
    pool.release(pool.acquire(1000, USAGE, 'a'))
    pool.release(pool.acquire(5000, USAGE, 'b'))
    pool.destroy()
    expect(dev.created.every((b) => b.destroyed)).toBe(true)
    expect(pool.bytes).toBe(0)
  })
})
