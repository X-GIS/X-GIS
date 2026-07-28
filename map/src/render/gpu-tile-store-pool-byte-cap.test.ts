// Byte gate for GpuTileStore's pooled-buffer recycler (#1357).
//
// THE BUG THIS PINS: _bufferPool was capped by ENTRY COUNT per bucket
// (_BUFFER_POOL_CAP_PER_BUCKET = 16) while its doc comment promised the cap
// "prevents the pool itself from holding GPU memory hostage". A count cap does
// not bound bytes, and the expensive buckets are exactly the large ones:
// buckets 2 KB → 4 MB sum to ~8.4 MB, so 16 each is ~134 MB of idle VRAM — and
// the pool key includes `usage`, so every usage-flag combination gets that
// ceiling independently. Nothing trimmed it either: releaseBuffer destroyed
// only on per-bucket overflow, and the sole drain was destroy(), so buffers
// parked by one transient spike stayed resident for the rest of the session.
//
// THE FIX: track pooled bytes and trim to _BUFFER_POOL_MAX_BYTES on release,
// evicting LARGEST bucket first.
//
// HOW THIS TEST WORKS: GpuTileStore's constructor is just `this.device =
// device`, and acquire/releaseBuffer operate purely on the pool via the mock
// device's createBuffer — so the whole recycler is reachable with no GPU. Every
// case below stays UNDER the 16/bucket count cap, so the count cap can never be
// what bounds it; only the byte cap can.

import { describe, expect, it } from 'vitest'
import { GpuTileStore } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'

interface MockBuffer {
  size: number
  usage: number
  destroyed: boolean
  destroy(): void
}

function mockDevice() {
  return {
    createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
      const b: MockBuffer = {
        size: desc.size,
        usage: desc.usage,
        destroyed: false,
        destroy() {
          b.destroyed = true
        },
      }
      return b as unknown as GPUBuffer
    },
  } as unknown as GPUDevice
}

const VERTEX_USAGE = 0x20 | 0x8 // GPUBufferUsage.VERTEX | COPY_DST
const MAX_BYTES = 16 * 1024 * 1024
const BIG = 4 * 1024 * 1024 // lands in the top (4 MB) bucket exactly
const SMALL = 1500 // lands in the 2 KB bucket

/** TypeScript `private` is not a runtime barrier — read the accumulator.
 *  It lives on the extracted GpuBufferPool (#1357); driving it through the
 *  STORE keeps this an integration gate, so a broken delegation shows up here
 *  rather than passing against the pool in isolation. */
const pooledBytesOf = (s: GpuTileStore): number =>
  (s as unknown as { _pool: { bytes: number } })._pool.bytes

function newStore(): GpuTileStore {
  const dev = mockDevice()
  return new GpuTileStore(dev, new WebGpuDevice(dev))
}

/** Park `n` DISTINCT buffers of `size` in the pool.
 *
 *  Acquire all of them BEFORE releasing any — acquiring and releasing one at a
 *  time is a no-op round trip, because the second acquire pops the buffer the
 *  first release just parked and hands the same object back, so the pool never
 *  grows past one. Freeing several buffers while the pool is drained is also
 *  what actually happens: `releaseTile` hands back a tile's line, index and
 *  outline buffers together. */
function parkMany(store: GpuTileStore, size: number, n: number): MockBuffer[] {
  const bufs = Array.from({ length: n }, (_, i) =>
    store.acquireBuffer(size, VERTEX_USAGE, `pooled-${i}`),
  )
  for (const b of bufs) store.releaseBuffer(b)
  return bufs as unknown as MockBuffer[]
}

describe('GpuTileStore buffer pool is bounded by BYTES, not just entry count (#1357)', () => {
  it('holds the byte ceiling while the per-bucket COUNT cap is nowhere near hit', () => {
    const store = newStore()

    // 10 × 4 MB = 40 MB offered. The count cap (16) does not fire at 10, so a
    // count-only bound parks all ten — 40 MB of idle VRAM. The byte cap admits
    // exactly floor(16 MB / 4 MB) = 4.
    const parked = parkMany(store, BIG, 10)

    expect(pooledBytesOf(store), 'pooled bytes must respect the ceiling').toBeLessThanOrEqual(
      MAX_BYTES,
    )
    const live = parked.filter((b) => !b.destroyed)
    expect(live.length, '16 MB / 4 MB = 4 buffers fit').toBe(4)
    expect(parked.filter((b) => b.destroyed).length, 'the rest are destroyed, not parked').toBe(6)
  })

  it('evicts the LARGEST bucket first, so hot small buffers survive a big-buffer spike', () => {
    const store = newStore()

    // The steady-state working set: small line/index buffers that churn every
    // frame. Parked first, so insertion-order eviction would take these.
    const small = parkMany(store, SMALL, 4)
    // Then a transient dense-tile spike parks several 4 MB buffers.
    const big = parkMany(store, BIG, 6)

    expect(pooledBytesOf(store)).toBeLessThanOrEqual(MAX_BYTES)
    expect(
      small.every((b) => !b.destroyed),
      'the spike must not evict the small buffers that carry the reuse',
    ).toBe(true)
    expect(
      big.some((b) => b.destroyed),
      'the spike itself must be trimmed',
    ).toBe(true)
  })

  it('accounting round-trips to zero — every parked byte is reclaimable', () => {
    const store = newStore()

    // Stay under BOTH caps so nothing is destroyed and the pool holds exactly
    // what was released; then drain it back through acquire.
    const sizes = [SMALL, 3000, 9000]
    for (const sz of sizes) parkMany(store, sz, 2)
    expect(pooledBytesOf(store)).toBeGreaterThan(0)

    // Re-acquiring at the same sizes must hit the pool and unwind the counter.
    // A decrement missing from acquireBuffer leaves this positive and would
    // make the pool falsely appear full forever.
    for (const sz of sizes)
      for (let i = 0; i < 2; i++) store.acquireBuffer(sz, VERTEX_USAGE, 'reuse')
    expect(pooledBytesOf(store), 'acquire must decrement what release incremented').toBe(0)
  })

  it('destroy() resets the accumulator along with the pool', () => {
    const store = newStore()
    parkMany(store, BIG, 1)
    expect(pooledBytesOf(store)).toBeGreaterThan(0)

    store.destroy()

    // A stale non-zero here would permanently shrink the usable pool on a
    // reused store, since the trim measures against this counter.
    expect(pooledBytesOf(store)).toBe(0)
  })
})
