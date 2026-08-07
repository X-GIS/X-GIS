// ═══ #1582 site 4 — UniformRing.stageSlot minted a fresh view per call ═══
//
// `stageSlot(offset, src)` allocated `new Uint8Array(src, 0, min(...))` on
// EVERY call, even though callers stage the SAME source ArrayBuffer every
// draw (VTR always passes `this.frameBlock.buffer`, constructed once per
// instance). Cached the view on `src` identity — a plain ArrayBuffer's
// byteLength is immutable, so the cached view stays valid for the life of
// that buffer.

import { describe, it, expect } from 'vitest'
import { UniformRing } from './uniform-ring'
import type { RhiBuffer, RhiDevice } from '@xgis/rhi'

;(globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage ??= {
  UNIFORM: 0x40,
  COPY_DST: 0x08,
  VERTEX: 0x20,
  INDEX: 0x10,
  STORAGE: 0x80,
  COPY_SRC: 0x04,
}

const SLOT = 256

function makeRing() {
  const device = {
    createBuffer: () => ({ id: 'buf' }) as unknown as RhiBuffer,
    writeBuffer: () => {},
    destroyBuffer: () => {},
  } as unknown as RhiDevice
  const ring = new UniformRing(device, SLOT, 8, 'test-ring', () => {})
  ring.ensure()
  return ring
}

interface RingPrivates {
  viewCache: WeakMap<ArrayBuffer, Uint8Array>
}
const privatesOf = (r: UniformRing): RingPrivates => r as unknown as RingPrivates

describe('#1582 site 4 — UniformRing.stageSlot caches the view by src identity', () => {
  it('the SAME source buffer staged twice reuses the SAME view instance', () => {
    const ring = makeRing()
    const priv = privatesOf(ring)
    const src = new ArrayBuffer(SLOT)

    ring.stageSlot(0, src)
    const viewAfterFirst = priv.viewCache.get(src)
    expect(viewAfterFirst, 'premise: the view is cached at all').toBeDefined()

    ring.stageSlot(SLOT, src)
    const viewAfterSecond = priv.viewCache.get(src)

    expect(viewAfterSecond, 'the second stage of the SAME src must reuse the cached view').toBe(
      viewAfterFirst,
    )
  })

  it('CONTROL — a DIFFERENT source buffer gets its OWN cached view, not the first one', () => {
    const ring = makeRing()
    const priv = privatesOf(ring)
    const srcA = new ArrayBuffer(SLOT)
    const srcB = new ArrayBuffer(SLOT)

    ring.stageSlot(0, srcA)
    ring.stageSlot(SLOT, srcB)

    const viewA = priv.viewCache.get(srcA)
    const viewB = priv.viewCache.get(srcB)
    expect(viewA).toBeDefined()
    expect(viewB).toBeDefined()
    expect(viewA, 'two distinct sources must not collapse to one cached view').not.toBe(viewB)
  })

  it('staged bytes still land correctly through the cached view (behaviour unchanged)', () => {
    const writes: { bufOffset: number; bytes: number[] }[] = []
    const device = {
      createBuffer: () => ({ id: 'buf' }) as unknown as RhiBuffer,
      writeBuffer: (_buf: unknown, bufOffset: number, view: Uint8Array) => {
        writes.push({ bufOffset, bytes: Array.from(view) })
      },
      destroyBuffer: () => {},
    } as unknown as RhiDevice
    const ring = new UniformRing(device, SLOT, 8, 'test-ring', () => {})
    ring.ensure()

    const src = new ArrayBuffer(4)
    new Uint8Array(src).set([1, 2, 3, 4])
    ring.stageSlot(0, src)
    ring.flush()

    expect(writes[0]!.bytes.slice(0, 4)).toEqual([1, 2, 3, 4])

    // Mutate the SAME buffer and stage it again — the cached view must
    // reflect the new bytes (it's a VIEW, not a snapshot).
    new Uint8Array(src).set([9, 9, 9, 9])
    ring.stageSlot(SLOT, src)
    ring.flush()

    expect(writes[1]!.bytes.slice(0, 4)).toEqual([9, 9, 9, 9])
  })
})
