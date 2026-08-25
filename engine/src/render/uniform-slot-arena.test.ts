// Unit tests for UniformSlotArena (#2042 INC-2) — the persistent sibling of
// UniformRing. Pins: freelist alloc/free/reuse + the double-free throw, the
// grow path (old-buffer push, whole-state re-dirty, staging preservation,
// onGrow), dirty-range flush coalescing, and the retired handoff — without a
// real GPU device (same RHI-shaped stub as uniform-ring.test.ts).

import { describe, it, expect } from 'vitest'
import { UniformSlotArena } from './uniform-slot-arena'
import type { RhiBuffer, RhiDevice } from '@xgis/rhi'

const SLOT = 256

interface FakeBuffer {
  id: string
  destroyed?: boolean
  bytes: Uint8Array
}

function makeArena(initialCapacity: number) {
  const writes: { buf: FakeBuffer; bufOffset: number; dataLen: number }[] = []
  const created: FakeBuffer[] = []
  let n = 0
  let onGrowCalls = 0
  const device = {
    createBuffer: (d: { size: number }) => {
      const b: FakeBuffer = { id: `buf${n++}`, bytes: new Uint8Array(d.size) }
      created.push(b)
      return b as unknown as RhiBuffer
    },
    writeBuffer: (buf: FakeBuffer, bufOffset: number, view: Uint8Array) => {
      writes.push({ buf, bufOffset, dataLen: view.byteLength })
      buf.bytes.set(view, bufOffset)
    },
    destroyBuffer: (buf: FakeBuffer) => {
      buf.destroyed = true
    },
  } as unknown as RhiDevice
  const arena = new UniformSlotArena(device, SLOT, initialCapacity, 'test-arena', () => {
    onGrowCalls++
  })
  return { arena, writes, created, getOnGrow: () => onGrowCalls }
}

const slotBytes = (fill: number): ArrayBuffer => {
  const b = new ArrayBuffer(SLOT)
  new Uint8Array(b).fill(fill)
  return b
}

describe('UniformSlotArena', () => {
  it('allocates stable slots, reuses freed ones LIFO, and tracks liveness', () => {
    const { arena } = makeArena(4)
    const a = arena.alloc()
    const b = arena.alloc()
    const c = arena.alloc()
    expect([a, b, c]).toEqual([0, 1, 2])
    expect(arena.liveCount()).toBe(3)
    arena.free(b)
    expect(arena.liveCount()).toBe(2)
    // Freed slot is reused before the high-water mark advances.
    expect(arena.alloc()).toBe(b)
    expect(arena.alloc()).toBe(3)
    expect(arena.liveCount()).toBe(4)
    expect(arena.byteOffset(3)).toBe(3 * SLOT)
  })

  it('free of a non-live slot throws (double-free = broken caller lifecycle)', () => {
    const { arena } = makeArena(2)
    const a = arena.alloc()
    arena.free(a)
    expect(() => arena.free(a)).toThrow(/non-live slot/)
    expect(() => arena.free(99)).toThrow(/non-live slot/)
  })

  it('stage + flush uploads ONE coalesced dirty range; clean flush is a no-op', () => {
    const { arena, writes } = makeArena(8)
    arena.ensure()
    const s0 = arena.alloc() // slot 0
    arena.alloc() // slot 1 (never staged — coalescing spans it)
    const s2 = arena.alloc() // slot 2
    arena.stage(s0, slotBytes(0xaa))
    arena.stage(s2, slotBytes(0xbb))
    arena.flush()
    expect(writes.length).toBe(1)
    expect(writes[0]!.bufOffset).toBe(0)
    expect(writes[0]!.dataLen).toBe(3 * SLOT) // slots 0..2 coalesced
    arena.flush() // clean — no-op
    expect(writes.length).toBe(1)
  })

  it('grow preserves every live slot byte in the NEW buffer and fires onGrow', () => {
    const { arena, created, getOnGrow } = makeArena(2)
    arena.ensure()
    expect(getOnGrow()).toBe(1)
    const s0 = arena.alloc()
    const s1 = arena.alloc()
    arena.stage(s0, slotBytes(0x11))
    arena.stage(s1, slotBytes(0x22))
    arena.flush()
    const s2 = arena.alloc() // grows 2 → 4
    expect(getOnGrow()).toBe(2)
    expect(arena.capacitySlots()).toBe(4)
    arena.stage(s2, slotBytes(0x33))
    arena.flush()
    // The NEW buffer holds ALL THREE slots — the persistent contents moved,
    // not just the current pass's writes (the ring-vs-arena difference).
    const grown = created[1]!
    expect(grown.bytes[s0 * SLOT]).toBe(0x11)
    expect(grown.bytes[s1 * SLOT]).toBe(0x22)
    expect(grown.bytes[s2 * SLOT]).toBe(0x33)
    // Old buffer retired to the caller, not destroyed.
    const retired = arena.takeRetired()
    expect(retired.length).toBe(1)
    expect((retired[0] as unknown as FakeBuffer).id).toBe(created[0]!.id)
    expect(created[0]!.destroyed).toBeUndefined()
    expect(arena.takeRetired()).toEqual([])
  })

  it('grow pushes the pass-staged dirty range into the OLD buffer first (recorded-draw parity)', () => {
    const { arena, created } = makeArena(1)
    arena.ensure()
    const s0 = arena.alloc()
    arena.stage(s0, slotBytes(0x77)) // staged, NOT flushed
    arena.alloc() // grow 1 → 2 mid-pass
    // The old buffer received the staged bytes before retiring.
    expect(created[0]!.bytes[0]).toBe(0x77)
  })

  it('destroy tears down the live buffer and any retired buffers', () => {
    const { arena, created } = makeArena(1)
    arena.ensure()
    arena.alloc()
    arena.alloc() // grow — retires buf0
    arena.destroy()
    expect(created[0]!.destroyed).toBe(true)
    expect(created[1]!.destroyed).toBe(true)
  })
})
