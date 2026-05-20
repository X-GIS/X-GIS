// Unit tests for GPUArena (Phase 6a.1, iter-207). Pins the
// allocator's correctness invariants:
//   - alignment (every offset is 4-byte aligned)
//   - free-list reuse (freed offsets come back on next alloc of same
//     bucket size)
//   - bump-pointer progress (allocs without free advance the bump)
//   - overflow detection (alloc beyond capacity throws)
//   - alloc / free symmetry on stats
//
// Mocks the GPUDevice / GPUBuffer surface — pure JS, no real WebGPU.

import { describe, it, expect } from 'vitest'
import { GPUArena, type GPUArenaDevice } from './gpu-arena'

interface MockBuffer {
  size: number
  usage: number
  label?: string
  destroyed: boolean
  destroy(): void
}

function mockDevice(): GPUArenaDevice {
  return {
    createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
      const b: MockBuffer = {
        size: desc.size,
        usage: desc.usage,
        label: desc.label,
        destroyed: false,
        destroy() { b.destroyed = true },
      }
      return b as unknown as GPUBuffer
    },
  }
}

const VERTEX_USAGE = 0x20 | 0x8  // GPUBufferUsage.VERTEX | COPY_DST

describe('GPUArena — construction', () => {
  it('allocates the underlying GPU buffer at requested capacity', () => {
    const a = new GPUArena(mockDevice(), {
      capacityBytes: 1024,
      usage: VERTEX_USAGE,
      label: 'test',
    })
    const buf = a.buffer as unknown as MockBuffer
    expect(buf.size).toBe(1024)
    expect(buf.usage).toBe(VERTEX_USAGE)
    expect(buf.label).toBe('test')
  })

  it('initial stats are zero', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const s = a.getStats()
    expect(s.totalAllocatedBytes).toBe(0)
    expect(s.liveBytes).toBe(0)
    expect(s.freeBytes).toBe(0)
    expect(s.allocCount).toBe(0)
    expect(s.freeCount).toBe(0)
    expect(s.reuseHits).toBe(0)
  })
})

describe('GPUArena — alloc bump pointer', () => {
  it('returns 0 for first allocation', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    expect(a.alloc(100)).toBe(0)
  })

  it('advances by ALIGNED bytes (rounds up to 4)', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    expect(a.alloc(10)).toBe(0)      // 10 → 12 aligned
    expect(a.alloc(8)).toBe(12)
    expect(a.alloc(5)).toBe(20)      // 5 → 8 aligned
    expect(a.alloc(4)).toBe(28)
  })

  it('every returned offset is 4-byte aligned', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 4096, usage: VERTEX_USAGE })
    const sizes = [1, 3, 7, 15, 31, 63, 127, 255]
    for (const n of sizes) {
      const off = a.alloc(n)
      expect(off % 4).toBe(0)
    }
  })

  it('throws on alloc beyond capacity', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 100, usage: VERTEX_USAGE })
    a.alloc(80)
    expect(() => a.alloc(40)).toThrow(/out of capacity/)
  })

  it('throws on negative / zero bytes', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 100, usage: VERTEX_USAGE })
    expect(() => a.alloc(0)).toThrow(/must be positive/)
    expect(() => a.alloc(-4)).toThrow(/must be positive/)
  })
})

describe('GPUArena — free + reuse', () => {
  it('freed offset comes back on next alloc of same bucket', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(12)
    const o2 = a.alloc(12)
    expect(o2).toBeGreaterThan(o1)  // bump-pointer progress
    a.free(o1, 12)
    const o3 = a.alloc(12)
    expect(o3).toBe(o1)  // reuse the freed slot, not extend bump
    expect(a.getStats().reuseHits).toBe(1)
  })

  it('LIFO reuse — most recently freed comes back first', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(16)
    const o2 = a.alloc(16)
    const o3 = a.alloc(16)
    a.free(o1, 16)
    a.free(o2, 16)
    a.free(o3, 16)
    // Pop order: o3 (top of stack), o2, o1
    expect(a.alloc(16)).toBe(o3)
    expect(a.alloc(16)).toBe(o2)
    expect(a.alloc(16)).toBe(o1)
  })

  it('different-bucket alloc does NOT reuse free-list slot', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(16)
    a.free(o1, 16)
    // Different bucket (bucketSize(64) = 64, not 16) → new bump alloc
    const o2 = a.alloc(64)
    expect(o2).not.toBe(o1)
    expect(a.getStats().reuseHits).toBe(0)
  })

  it('free is a silent no-op when bytes <= 0', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    a.alloc(16)
    expect(() => a.free(0, 0)).not.toThrow()
    expect(() => a.free(8, -4)).not.toThrow()
    expect(a.getStats().freeCount).toBe(0)
  })
})

describe('GPUArena — bucket sizing (power of 2)', () => {
  it('rounds request to next power of 2, minimum 16', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    // 12 → bucket 16
    const o1 = a.alloc(12)
    a.free(o1, 12)
    // 16-byte request → bucket 16 → reuses
    expect(a.alloc(16)).toBe(o1)
  })

  it('17-byte request rounds to bucket 32', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(17)  // aligned 20, bucket 32
    a.free(o1, 17)
    // 32-byte request → same bucket → reuse
    expect(a.alloc(32)).toBe(o1)
    // 16-byte does NOT reuse (different bucket)
    const o2 = a.alloc(16)
    expect(o2).not.toBe(o1)
  })

  it('tiny allocs (< 16 B) share bucket 16', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(1)
    a.free(o1, 1)
    // Any sub-16 request reuses
    expect(a.alloc(4)).toBe(o1)
  })
})

describe('GPUArena — stats accounting', () => {
  it('alloc + free are symmetric on counts', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(16)
    const o2 = a.alloc(32)
    const s1 = a.getStats()
    expect(s1.allocCount).toBe(2)
    expect(s1.freeCount).toBe(0)
    a.free(o1, 16)
    a.free(o2, 32)
    const s2 = a.getStats()
    expect(s2.allocCount).toBe(2)
    expect(s2.freeCount).toBe(2)
  })

  it('liveBytes tracks net active allocations', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(16)
    expect(a.getStats().liveBytes).toBe(16)
    const o2 = a.alloc(32)
    expect(a.getStats().liveBytes).toBe(48)
    a.free(o1, 16)
    expect(a.getStats().liveBytes).toBe(32)
    a.free(o2, 32)
    expect(a.getStats().liveBytes).toBe(0)
  })

  it('reuseHits increments on free-list pops, not bump-pointer extensions', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    a.alloc(16)
    a.alloc(16)
    expect(a.getStats().reuseHits).toBe(0)
    const o = a.alloc(16)
    a.free(o, 16)
    a.alloc(16)  // reuses o
    expect(a.getStats().reuseHits).toBe(1)
  })

  it('freeBytes reflects free-list contents (bucket size × count)', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(12)
    const o2 = a.alloc(12)
    a.free(o1, 12)  // bucket 16
    a.free(o2, 12)  // bucket 16
    // 2 entries in bucket 16 → freeBytes = 32
    expect(a.getStats().freeBytes).toBe(32)
  })
})

describe('GPUArena — lifecycle', () => {
  it('reset() clears bookkeeping but keeps buffer alive', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    a.alloc(16)
    a.alloc(32)
    a.reset()
    const s = a.getStats()
    expect(s.totalAllocatedBytes).toBe(0)
    expect(s.liveBytes).toBe(0)
    expect(s.freeBytes).toBe(0)
    expect((a.buffer as unknown as MockBuffer).destroyed).toBe(false)
    // Post-reset alloc starts from offset 0 again.
    expect(a.alloc(16)).toBe(0)
  })

  it('destroy() destroys the buffer + clears bookkeeping', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    a.alloc(16)
    a.destroy()
    expect((a.buffer as unknown as MockBuffer).destroyed).toBe(true)
    expect(a.getStats().liveBytes).toBe(0)
  })
})

describe('GPUArena — steady-state simulation', () => {
  it('frame-loop pattern: alloc + free same bucket repeats reuses same slot', () => {
    // Models the VTR upload pattern: tile A is uploaded (alloc),
    // evicted (free), new tile B same bucket size (alloc) →
    // should occupy the SAME offset. Steady-state arena under
    // even churn never extends the bump pointer.
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const FRAMES = 100
    let lastOffset = -1
    for (let i = 0; i < FRAMES; i++) {
      const off = a.alloc(128)
      if (i === 0) lastOffset = off
      else expect(off).toBe(lastOffset)  // same slot reused every frame
      a.free(off, 128)
    }
    // BumpPtr advanced exactly once (the first alloc).
    expect(a.getStats().totalAllocatedBytes).toBe(128)
    expect(a.getStats().reuseHits).toBe(FRAMES - 1)
  })

  it('mixed bucket churn produces NO leak: liveBytes returns to 0', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 4096, usage: VERTEX_USAGE })
    const sizes = [12, 128, 64, 256, 16, 32, 768]
    const offs: { off: number; size: number }[] = []
    for (const s of sizes) offs.push({ off: a.alloc(s), size: s })
    expect(a.getStats().liveBytes).toBeGreaterThan(0)
    for (const o of offs) a.free(o.off, o.size)
    expect(a.getStats().liveBytes).toBe(0)
  })
})
