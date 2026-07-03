// Unit tests for GPUArena (Phase 6a.1, iter-207). Pins the
// allocator's correctness invariants:
//   - alignment (every offset is 4-byte aligned)
//   - free-list reuse (freed offsets come back on next alloc of the
//     same exact align4 footprint)
//   - bump-pointer progress (allocs without free advance the bump)
//   - overflow detection (alloc beyond capacity throws)
//   - alloc / free symmetry on stats
//
// Mocks the GPUDevice / GPUBuffer surface — pure JS, no real WebGPU.

import { describe, it, expect } from 'vitest'
import { GPUArena, type GPUArenaDevice } from './gpu-arena'
import type { RhiBuffer } from '../render/rhi/rhi'

interface MockBuffer {
  size: number
  usage: string
  copySrc?: boolean
  label?: string
  destroyed: boolean
  destroy(): void
}

// The arena now drives the RHI device subset: createBuffer({desc}) → RhiBuffer
// ({native} shape, the same WebGpuDevice wrap the arena unwraps) + destroyBuffer.
const unwrap = (h: unknown): MockBuffer => (h as { native: MockBuffer }).native

function mockDevice(): GPUArenaDevice {
  return {
    createBuffer(desc): RhiBuffer {
      const b: MockBuffer = {
        size: desc.size,
        usage: desc.usage,
        copySrc: desc.copySrc,
        label: desc.label,
        destroyed: false,
        destroy() { b.destroyed = true },
      }
      return { native: b } as unknown as RhiBuffer
    },
    destroyBuffer(h) { unwrap(h).destroy() },
    unwrapBuffer(h) { return unwrap(h) as unknown as GPUBuffer },
  }
}

const VERTEX_USAGE = 'vertex'  // RhiBufferUsage role (was GPUBufferUsage.VERTEX | COPY_DST)

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

  it('different-size alloc does NOT reuse free-list slot', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(16)
    a.free(o1, 16)
    // Different exact-aligned footprint (64 ≠ 16) → new bump alloc
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

describe('GPUArena — exact-align4 free-list reuse', () => {
  it('reuse keys on exact align4 footprint, not a power-of-2 bucket', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    // 12 → align4 12
    const o1 = a.alloc(12)
    a.free(o1, 12)
    // 16-byte request → align4 16 ≠ 12 → does NOT reuse
    const o2 = a.alloc(16)
    expect(o2).not.toBe(o1)
    // 12-byte request → align4 12 → reuses o1
    expect(a.alloc(12)).toBe(o1)
  })

  it('17-byte (align4 20) only reuses for an align4-20 request', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(17)  // align4 20
    a.free(o1, 17)
    // 32-byte request (align4 32 ≠ 20) does NOT reuse (the old bucket
    // scheme would have — and would have overrun the 20 B slot).
    const o2 = a.alloc(32)
    expect(o2).not.toBe(o1)
    // 20-byte request (align4 20) reuses
    expect(a.alloc(20)).toBe(o1)
  })

  it('tiny allocs reuse only at their own exact align4 footprint', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(1)  // align4 4
    a.free(o1, 1)
    // 8-byte request (align4 8 ≠ 4) does NOT reuse
    const o2 = a.alloc(8)
    expect(o2).not.toBe(o1)
    // 4-byte request (align4 4) reuses
    expect(a.alloc(4)).toBe(o1)
  })

  it('no-overwrite invariant: a freed 20 B slot never satisfies a 28 B request', () => {
    // Pins the Lane-C correctness fix: under the old next-pow2 bucket
    // scheme alloc(20) and alloc(28) shared bucket 32, so a 28 B request
    // could reuse a freed 20 B slot and overrun the neighbour. With
    // exact-align4 keying it must bump a fresh range instead.
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(20)
    a.free(o1, 20)
    const o2 = a.alloc(28)
    expect(o2).not.toBe(o1)
    expect(a.getStats().reuseHits).toBe(0)
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

  it('freeBytes reflects free-list contents (exact align4 size × count)', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(12)
    const o2 = a.alloc(12)
    a.free(o1, 12)  // align4 12
    a.free(o2, 12)  // align4 12
    // 2 entries × align4 12 → freeBytes = 24 (exact, not bucket-inflated)
    expect(a.getStats().freeBytes).toBe(24)
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

describe('GPUArena — byte-pressure getters (Lane A signals)', () => {
  it('usedBytes equals bumpPtr: rises on alloc, does NOT fall on free', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    expect(a.highWaterBytes).toBe(0)
    a.alloc(64)  // bumpPtr → 64
    expect(a.highWaterBytes).toBe(64)
    a.alloc(32)  // bumpPtr → 96
    expect(a.highWaterBytes).toBe(96)
    const o = a.alloc(128)  // bumpPtr → 224
    expect(a.highWaterBytes).toBe(224)
    a.free(o, 128)           // liveBytes falls, but bumpPtr/usedBytes stays at 224
    expect(a.highWaterBytes).toBe(224)  // MONOTONIC — this is the OOM trigger signal
  })

  it('liveUsedBytes equals net in-flight bytes: rises on alloc, falls on free', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    expect(a.liveUsedBytes).toBe(0)
    const o1 = a.alloc(64)
    expect(a.liveUsedBytes).toBe(64)
    const o2 = a.alloc(32)
    expect(a.liveUsedBytes).toBe(96)
    a.free(o1, 64)
    expect(a.liveUsedBytes).toBe(32)   // falls — this is the eviction loop signal
    a.free(o2, 32)
    expect(a.liveUsedBytes).toBe(0)
  })

  it('pressure() = usedBytes / capacity (monotonic fraction)', () => {
    // Use multiples of 4 for both capacity and alloc sizes so align4()
    // is a no-op and the ratio is exact.
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    expect(a.pressure()).toBe(0)
    a.alloc(512)
    expect(a.pressure()).toBeCloseTo(0.5, 5)
    const o = a.alloc(256)
    expect(a.pressure()).toBeCloseTo(0.75, 5)
    a.free(o, 256)
    // Still 0.75 — bumpPtr unchanged after free
    expect(a.pressure()).toBeCloseTo(0.75, 5)
  })

  it('livePressure() = liveUsedBytes / capacity (tracks freed slots)', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1000, usage: VERTEX_USAGE })
    const o1 = a.alloc(600)
    const o2 = a.alloc(200)
    expect(a.livePressure()).toBeCloseTo(0.8, 5)
    a.free(o1, 600)
    expect(a.livePressure()).toBeCloseTo(0.2, 5)
    a.free(o2, 200)
    expect(a.livePressure()).toBe(0)
  })

  it('HIGH_WATER trigger: usedBytes crosses 75% before liveUsedBytes does when free-list is populated', () => {
    // Simulates the OOM scenario: 80% of bump space used (usedBytes > 75%
    // of capacity), but 40% freed so liveUsedBytes is only 40% live. The
    // byte-aware eviction trigger in beginFrame reads usedBytes (bumpPtr),
    // NOT liveUsedBytes — so it fires correctly. liveUsedBytes (the loop-
    // termination signal) would NOT fire the trigger (40% < 75%), which
    // is why the original count-only trigger missed this case.
    const cap = 1024
    const HIGH_WATER = 0.75
    const a = new GPUArena(mockDevice(), { capacityBytes: cap, usage: VERTEX_USAGE })
    // Alloc 80% then free half → usedBytes=80%, liveUsedBytes=40%
    const off1 = a.alloc(512)  // align4(512)=512
    const off2 = a.alloc(308)  // align4(308)=308; bumpPtr=820 ≈ 80%
    a.free(off1, 512)           // liveBytes=308, bumpPtr=820
    expect(a.highWaterBytes / cap).toBeGreaterThan(HIGH_WATER)   // trigger fires ✓
    expect(a.liveUsedBytes / cap).toBeLessThan(HIGH_WATER)  // loop signal correct ✓
    void off2  // suppress unused warning
  })

  it('reclaimIfDrained resets bumpPtr to 0 when liveBytes is zero', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(256)
    const o2 = a.alloc(256)
    expect(a.highWaterBytes).toBe(512)
    a.free(o1, 256)
    a.free(o2, 256)
    expect(a.liveUsedBytes).toBe(0)
    expect(a.highWaterBytes).toBe(512)  // bumpPtr pinned until reclaim
    const reclaimed = a.reclaimIfDrained()
    expect(reclaimed).toBe(true)
    expect(a.highWaterBytes).toBe(0)    // bumpPtr reset — next alloc starts fresh
    expect(a.liveUsedBytes).toBe(0)
    // Arena is usable again from the top
    expect(a.alloc(256)).toBe(0)
  })

  it('reclaimIfDrained is a no-op when live allocations remain', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(256)
    a.alloc(128)        // second alloc NOT freed — still live
    a.free(o1, 256)
    expect(a.liveUsedBytes).toBe(128)
    const reclaimed = a.reclaimIfDrained()
    expect(reclaimed).toBe(false)  // refused: live allocs would dangle
    expect(a.highWaterBytes).toBe(384)  // bumpPtr unchanged
  })
})

describe('GPUArena — canServe (exact O(1) serviceability probe)', () => {
  it('true via bump headroom when nothing is free yet', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 100, usage: VERTEX_USAGE })
    expect(a.canServe(80)).toBe(true)   // 80 ≤ 100 bump headroom
    expect(a.canServe(100)).toBe(true)  // exact fit
    expect(a.canServe(101)).toBe(false) // beyond capacity
  })

  it('false once bump headroom is exhausted and no matching free slot exists', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 100, usage: VERTEX_USAGE })
    a.alloc(80)                         // bumpPtr = 80, 20 left
    expect(a.canServe(20)).toBe(true)   // exactly fits remaining bump
    expect(a.canServe(24)).toBe(false)  // no bump room, no free slot
  })

  it('true via exact-align4 free-list slot even when bump headroom is gone', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 100, usage: VERTEX_USAGE })
    const o = a.alloc(40)               // bumpPtr = 40
    a.alloc(60)                         // bumpPtr = 100, fully bumped out
    expect(a.canServe(40)).toBe(false)  // no free slot yet, no bump room
    a.free(o, 40)                       // push a 40 B slot to the free-list
    expect(a.canServe(40)).toBe(true)   // matching free-list footprint
  })

  it('NOT fooled by fragmentation: summed free bytes ≠ a serviceable footprint', () => {
    // The bug canServe replaces: getStats().freeBytes sums across distinct
    // exact-align4 size-keys. Here freeBytes = 12 + 20 = 32, but no single
    // slot can serve a 28 B request — canServe must say false while the old
    // `freeBytes >= needed` check would have falsely said true.
    const a = new GPUArena(mockDevice(), { capacityBytes: 32, usage: VERTEX_USAGE })
    const o1 = a.alloc(12)              // align4 12
    const o2 = a.alloc(20)             // align4 20; bumpPtr = 32 (full)
    a.free(o1, 12)
    a.free(o2, 20)
    expect(a.getStats().freeBytes).toBe(32)  // SUM across mismatched keys
    expect(a.canServe(28)).toBe(false)       // but no 28 B (align4 28) slot
    expect(a.canServe(20)).toBe(true)        // exact 20 B slot is reusable
    expect(a.canServe(12)).toBe(true)        // exact 12 B slot is reusable
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

// ── Compaction (Phase 6a.5) ──────────────────────────────────────────
// Recording encoder for copyBufferToBuffer assertions.
interface RecordedCopy {
  source: GPUBuffer
  sourceOffset: number
  destination: GPUBuffer
  destinationOffset: number
  size: number
}
function recordingEncoder() {
  const copies: RecordedCopy[] = []
  const enc = {
    // The arena passes RHI handles ({native} wraps); unwrap to the underlying
    // MockBuffer so the source/destination identity assertions compare against
    // `a.buffer` (which the arena exposes already-unwrapped).
    copyBufferToBuffer(
      source: RhiBuffer, sourceOffset: number,
      destination: RhiBuffer, destinationOffset: number, size: number,
    ): void {
      copies.push({
        source: unwrap(source) as unknown as GPUBuffer,
        sourceOffset,
        destination: unwrap(destination) as unknown as GPUBuffer,
        destinationOffset,
        size,
      })
    },
  }
  return { enc, copies }
}

describe('GPUArena — compaction (defrag relocation)', () => {
  it('relocates the live set to the front of a FRESH buffer and resets bump', () => {
    // Reproduce the fragmentation crash signature: heterogeneous tile
    // sizes strand the free-list so bumpPtr climbs to the cap while
    // liveBytes is tiny. Compaction must drop bumpPtr back to the packed
    // live total.
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(100)   // align4 100
    const o2 = a.alloc(40)    // align4 40
    const o3 = a.alloc(200)   // align4 200
    // Free the middle one — strands a 40 B slot that won't match the next
    // (differently-sized) request.
    a.free(o2, 40)
    a.alloc(300)              // bumpPtr climbs further (no 300 B slot free)
    const before = a.getStats()
    expect(before.totalAllocatedBytes).toBe(100 + 40 + 200 + 300) // 640 bump
    expect(before.liveBytes).toBe(100 + 200 + 300)                // 600 live

    // Live set = o1(100), o3(200), and the last 300 B alloc. Caller passes
    // exactly the live slots.
    const oldBuffer = a.buffer
    const { enc, copies } = recordingEncoder()
    const result = a.compact(
      [
        { oldOffset: o1, bytes: 100 },
        { oldOffset: o3, bytes: 200 },
        { oldOffset: 340, bytes: 300 }, // the 300 B alloc landed at 340
      ],
      enc,
    )

    // New buffer is a distinct GPUBuffer (ping-pong, not in-place).
    expect(a.buffer).not.toBe(oldBuffer)
    expect(result.oldBuffer).toBe(oldBuffer)
    // bumpPtr + liveBytes collapse to the packed total (600), NOT 640.
    expect(a.highWaterBytes).toBe(600)
    expect(a.liveUsedBytes).toBe(600)
    // Free-list cleared — no stranded bytes remain.
    expect(a.getStats().freeBytes).toBe(0)

    // New offsets are packed front-to-back in input order.
    expect(result.newOffsets).toEqual([0, 100, 300])

    // Each copy reads the OLD buffer at the live offset and writes the
    // NEW buffer at the packed offset, aligned size.
    expect(copies).toHaveLength(3)
    expect(copies[0]).toMatchObject({
      source: oldBuffer, sourceOffset: o1, destination: a.buffer,
      destinationOffset: 0, size: 100,
    })
    expect(copies[1]).toMatchObject({
      source: oldBuffer, sourceOffset: o3, destination: a.buffer,
      destinationOffset: 100, size: 200,
    })
    expect(copies[2]).toMatchObject({
      source: oldBuffer, sourceOffset: 340, destination: a.buffer,
      destinationOffset: 300, size: 300,
    })
  })

  it('every copy size is 4-byte aligned (copyBufferToBuffer requirement)', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 1024, usage: VERTEX_USAGE })
    const o1 = a.alloc(13)  // align4 16
    const o2 = a.alloc(17)  // align4 20
    const { enc, copies } = recordingEncoder()
    a.compact([{ oldOffset: o1, bytes: 13 }, { oldOffset: o2, bytes: 17 }], enc)
    for (const c of copies) expect(c.size % 4).toBe(0)
    expect(copies[0].size).toBe(16)
    expect(copies[1].size).toBe(20)
    // Packed offsets honour the aligned footprints.
    expect(a.highWaterBytes).toBe(36)
  })

  it('post-compaction arena is immediately allocatable from the packed top', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 512, usage: VERTEX_USAGE })
    const o1 = a.alloc(64)
    a.alloc(64)              // bumpPtr = 128
    a.free(o1, 64)           // strand a 64 B slot
    const { enc } = recordingEncoder()
    // Only the second alloc is live (offset 64).
    a.compact([{ oldOffset: 64, bytes: 64 }], enc)
    expect(a.highWaterBytes).toBe(64)
    // Next alloc extends from the packed top, not the old 128 bump.
    expect(a.alloc(64)).toBe(64)
    expect(a.highWaterBytes).toBe(128)
  })

  it('compacting an empty live set yields a fresh empty buffer', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 256, usage: VERTEX_USAGE })
    const o1 = a.alloc(64)
    a.free(o1, 64)           // nothing live, bumpPtr still 64
    const oldBuffer = a.buffer
    const { enc, copies } = recordingEncoder()
    const result = a.compact([], enc)
    expect(copies).toHaveLength(0)
    expect(result.newOffsets).toEqual([])
    expect(result.oldBuffer).toBe(oldBuffer)
    expect(a.highWaterBytes).toBe(0)
    expect(a.liveUsedBytes).toBe(0)
    expect(a.alloc(64)).toBe(0)
  })

  it('compactionCount increments per compaction', () => {
    const a = new GPUArena(mockDevice(), { capacityBytes: 256, usage: VERTEX_USAGE })
    a.alloc(32)
    expect(a.compactionCount).toBe(0)
    const { enc } = recordingEncoder()
    a.compact([{ oldOffset: 0, bytes: 32 }], enc)
    expect(a.compactionCount).toBe(1)
    a.compact([{ oldOffset: 0, bytes: 32 }], enc)
    expect(a.compactionCount).toBe(2)
  })

  it('the new buffer carries the same usage + label as the original', () => {
    const a = new GPUArena(mockDevice(), {
      capacityBytes: 256, usage: VERTEX_USAGE, label: 'poly-vertex-arena',
    })
    a.alloc(32)
    const { enc } = recordingEncoder()
    a.compact([{ oldOffset: 0, bytes: 32 }], enc)
    const nb = a.buffer as unknown as MockBuffer
    expect(nb.usage).toBe(VERTEX_USAGE)
    expect(nb.label).toBe('poly-vertex-arena')
    expect(nb.size).toBe(256)
  })
})
