// Gate for GPUArena auto-grow (Phase 6a.5, US-003).
//
// THE FEATURE THIS PINS: `compact(relocations, encoder, targetCapacity)`
// relocates the live set into a buffer of `targetCapacity` bytes instead of
// the current capacity — the auto-grow primitive. The store drives it on
// alloc-fail when the eviction-PROTECTED live set genuinely exceeds capacity
// (extreme zoom/pitch fill-extrusion: every visible tile is protected, so
// neither byte-eviction nor same-size compaction can relieve the pressure).
//
// FAIL-BEFORE: before the `targetCapacity` parameter existed, compact() always
// re-sized to the current capacity, so `capacityBytes` stayed put and the
// previously-failing alloc kept throwing — the grow assertions below fail.
//
// HOW THIS TEST WORKS: GPUArena needs only `createBuffer` from the device and
// `copyBufferToBuffer` from the encoder; both are trivially mocked (same
// pattern as arena-eviction-policy.test.ts). We fill to capacity, confirm
// alloc throws, then compact into a 2× buffer and assert the live set is
// preserved, capacity grew, the fresh buffer was sized to the target, and the
// previously-failing alloc now succeeds.

import { describe, expect, it } from 'vitest'
import { GPUArena, type GPUArenaDevice } from './gpu-arena'
import type { RhiBuffer } from '../render/rhi/rhi'

interface MockBuffer { size: number; destroyed: boolean; destroy(): void }

const unwrap = (h: unknown): MockBuffer => (h as { native: MockBuffer }).native

function mockDevice(): { dev: GPUArenaDevice; created: MockBuffer[] } {
  const created: MockBuffer[] = []
  const dev: GPUArenaDevice = {
    createBuffer(desc): RhiBuffer {
      const b: MockBuffer = { size: desc.size, destroyed: false, destroy() { b.destroyed = true } }
      created.push(b)
      return { native: b } as unknown as RhiBuffer
    },
    destroyBuffer(h) { unwrap(h).destroy() },
    unwrapBuffer(h) { return unwrap(h) as unknown as GPUBuffer },
  }
  return { dev, created }
}

// Records the relocation copies so we can assert no live slot is dropped.
function mockEncoder(): { enc: { copyBufferToBuffer(...a: unknown[]): void }; copies: Array<{ srcOff: number; dstOff: number; size: number }> } {
  const copies: Array<{ srcOff: number; dstOff: number; size: number }> = []
  const enc = {
    copyBufferToBuffer(_src: unknown, srcOff: number, _dst: unknown, dstOff: number, size: number) {
      copies.push({ srcOff, dstOff, size })
    },
  }
  return { enc, copies }
}

const VERTEX_USAGE = 'vertex' // RhiBufferUsage role (was GPUBufferUsage.VERTEX | COPY_DST)

describe('GPUArena.compact(targetCapacity) — auto-grow', () => {
  it('grows capacity, preserves the live set, and serves the previously-failing alloc', () => {
    const { dev, created } = mockDevice()
    const CAP = 4096
    const arena = new GPUArena(dev, { capacityBytes: CAP, usage: VERTEX_USAGE, label: 'poly-vertex-arena' })

    // Fill to capacity with 4 × 1KB allocs (all live / protected — never freed).
    const TILE = 1024
    const live: Array<{ oldOffset: number; bytes: number }> = []
    for (let i = 0; i < 4; i++) live.push({ oldOffset: arena.alloc(TILE), bytes: TILE })
    expect(arena.liveUsedBytes).toBe(4 * TILE)

    // Arena is full: the next alloc must throw (the OOM condition).
    expect(() => arena.alloc(TILE)).toThrow(/out of capacity/)

    // Grow: compact the live set into a 2× buffer.
    const { enc, copies } = mockEncoder()
    const TARGET = CAP * 2
    const result = arena.compact(live, enc as unknown as Parameters<typeof arena.compact>[1], TARGET)

    // Capacity grew (FAIL-BEFORE: stayed at CAP without the target param).
    expect(arena.capacityBytes).toBe(TARGET)
    // The fresh destination buffer was sized to the target.
    expect(created[created.length - 1]!.size).toBe(TARGET)
    // Live set preserved + packed contiguous from offset 0.
    expect(result.newOffsets).toEqual([0, 1024, 2048, 3072])
    expect(arena.liveUsedBytes).toBe(4 * TILE)
    // Every live slot was copied (none dropped).
    expect(copies.length).toBe(4)
    expect(copies.every(c => c.size === TILE)).toBe(true)
    // The old buffer is returned for deferred retire, not destroyed here.
    expect((result.oldBuffer as unknown as MockBuffer).destroyed).toBe(false)

    // The previously-failing alloc now succeeds against the grown capacity.
    expect(() => arena.alloc(TILE)).not.toThrow()
  })

  it('defaults to a same-size defrag when no target is passed (capacity unchanged)', () => {
    const { dev } = mockDevice()
    const CAP = 4096
    const arena = new GPUArena(dev, { capacityBytes: CAP, usage: VERTEX_USAGE })
    const live = [{ oldOffset: arena.alloc(1024), bytes: 1024 }]
    const { enc } = mockEncoder()
    arena.compact(live, enc as unknown as Parameters<typeof arena.compact>[1])
    expect(arena.capacityBytes).toBe(CAP)  // no grow without an explicit target
  })
})
