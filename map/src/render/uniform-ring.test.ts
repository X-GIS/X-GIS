// Unit tests for the shared UniformRing (extracted from MapRenderer + VTR).
// Pins the iter-348 mid-grow old-buffer flush, the grow/staging math, the
// flush dirty-range upload, and the caller-policy retired handoff — without
// a real WebGPU device.

import { describe, it, expect } from 'vitest'
import { UniformRing } from './uniform-ring'
import type { RhiBuffer, RhiDevice } from '@xgis/engine'

;(globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage ??= {
  UNIFORM: 0x40,
  COPY_DST: 0x08,
  VERTEX: 0x20,
  INDEX: 0x10,
  STORAGE: 0x80,
  COPY_SRC: 0x04,
}

const SLOT = 256

interface FakeBuffer {
  id: string
  destroyed?: boolean
}

function makeRing(initialCapacity: number) {
  const writes: { buf: FakeBuffer; bufOffset: number; dataLen: number }[] = []
  const created: FakeBuffer[] = []
  let n = 0
  let onGrowCalls = 0
  // RHI-shaped stub (#832 M2) — the ring now creates/writes/destroys through
  // the backend-blind RhiDevice port (writeBuffer receives a subarray VIEW, so
  // dataLen = view.byteLength, same value the queue-tail `size` param carried).
  const device = {
    createBuffer: () => {
      const b: FakeBuffer = { id: `buf${n++}` }
      created.push(b)
      return b as unknown as RhiBuffer
    },
    writeBuffer: (buf: FakeBuffer, bufOffset: number, view: Uint8Array) => {
      writes.push({ buf, bufOffset, dataLen: view.byteLength })
    },
    destroyBuffer: (buf: FakeBuffer) => {
      buf.destroyed = true
    },
  } as unknown as RhiDevice
  const ring = new UniformRing(device, SLOT, initialCapacity, 'test-ring', () => {
    onGrowCalls++
  })
  return { ring, writes, created, getOnGrow: () => onGrowCalls }
}

describe('UniformRing', () => {
  it('ensure() lazily creates the buffer and fires onGrow once (idempotent)', () => {
    const { ring, created, getOnGrow } = makeRing(8)
    expect(ring.rhiBuffer).toBeNull()
    ring.ensure()
    expect(ring.rhiBuffer).toBe(created[0] as unknown)
    expect(getOnGrow()).toBe(1)
    ring.ensure()
    expect(created.length).toBe(1)
    expect(getOnGrow()).toBe(1)
  })

  it('allocSlot returns sequential byte offsets', () => {
    const { ring } = makeRing(8)
    ring.ensure()
    expect(ring.allocSlot()).toBe(0)
    expect(ring.allocSlot()).toBe(SLOT)
    expect(ring.allocSlot()).toBe(2 * SLOT)
  })

  it('grow flushes THIS frame staged slots into the OLD buffer before retiring (iter-348)', () => {
    const { ring, writes, created } = makeRing(2)
    ring.ensure()
    const oldBuf = created[0]!
    ring.allocSlot()
    ring.allocSlot() // fill capacity (slot cursor → 2)
    ring.stageSlot(0, new ArrayBuffer(SLOT))
    ring.allocSlot() // slot 2 >= capacity → grow
    const oldWrite = writes.find((w) => w.buf === oldBuf)
    expect(oldWrite, 'old buffer flushed on grow').toBeDefined()
    expect(oldWrite!.bufOffset).toBe(0)
    expect(oldWrite!.dataLen).toBe(2 * SLOT) // cursor was 2 at grow
    expect(ring.takeRetired()).toContain(oldBuf)
  })

  it('capacity doubles past the requested minimum and fires onGrow per grow', () => {
    const { ring, created, getOnGrow } = makeRing(2)
    ring.ensure()
    expect(getOnGrow()).toBe(1) // ensure
    ring.allocSlot()
    ring.allocSlot()
    ring.allocSlot() // slot 2 → grow to 4
    expect(created.length).toBe(2)
    expect(getOnGrow()).toBe(2) // ensure + 1 grow
  })

  it('flush writes the dirty range to the current buffer, then no-ops when clean', () => {
    const { ring, writes, created } = makeRing(8)
    ring.ensure()
    ring.stageSlot(0, new ArrayBuffer(SLOT))
    ring.stageSlot(SLOT, new ArrayBuffer(SLOT))
    ring.flush()
    const cur = created[0]!
    const flushWrite = writes.find((w) => w.buf === cur && w.bufOffset === 0)
    expect(flushWrite).toBeDefined()
    expect(flushWrite!.dataLen).toBe(2 * SLOT)
    const before = writes.length
    ring.flush()
    expect(writes.length).toBe(before)
  })

  it('takeRetired returns then clears; resetSlot rewinds the cursor', () => {
    const { ring } = makeRing(1)
    ring.ensure()
    ring.allocSlot()
    ring.allocSlot() // grow → 1 retired
    expect(ring.takeRetired().length).toBe(1)
    expect(ring.takeRetired().length).toBe(0)
    ring.resetSlot()
    expect(ring.allocSlot()).toBe(0)
  })

  it('destroy() clears the live buffer reference', () => {
    const { ring } = makeRing(1)
    ring.ensure()
    ring.allocSlot()
    ring.allocSlot()
    ring.destroy()
    expect(ring.rhiBuffer).toBeNull()
  })
})
