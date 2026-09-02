// ═══ UniformSlotArena — persistent fixed-stride uniform slots (#2042 INC-2) ═══
//
// The PERSISTENT sibling of UniformRing: one growable uniform buffer of
// fixed-size slots, but slots are ALLOCATED and FREED (free-list) instead of
// cursor-reset every frame. A slot's byte offset is stable for its whole
// lifetime, which is what lets a caller bind it from retained state (a
// RenderBundle, a cached bind) without any per-frame restaging — the
// addressing half of the Frame/Show/Tile uniform-block split
// (docs/plans/2026-08-24-uniform-block-split.md).
//
// Same conventions as UniformRing (deliberately — one mental model):
//   - CPU staging mirror + dirty-range coalescing; `flush()` is ONE
//     writeBuffer per pass.
//   - Backend-neutral: create/write/destroy only through the RhiDevice port.
//   - Grow policy: doubling; the old buffer receives this pass's staged
//     dirty range BEFORE retiring (draws already recorded against it must
//     not read stale bytes), the new buffer receives EVERYTHING live via a
//     whole-range dirty mark (persistent slots must survive the move).
//   - Caller policy stays with the caller: bind-group rebuild via `onGrow`,
//     retired-buffer disposal via `takeRetired()`.
//
// Always-on liveness accounting: `alloc`/`free` maintain a live set, and
// `free` of a non-live slot THROWS — a double-free or stale-key free is a
// lifecycle bug upstream (the tile-eviction seam), and silently absorbing it
// would let the leak gate (live slots === live tiles) drift green.

import type { RhiBuffer, RhiDevice } from '@xgis/rhi'
import { trackOwner, untrackOwner } from '@xgis/shared'

export class UniformSlotArena {
  private _buffer: RhiBuffer | null = null
  private capacity: number
  private next = 0
  private readonly freeList: number[] = []
  private readonly live = new Set<number>()
  private staging: Uint8Array
  private dirtyLo = 0
  private dirtyHi = 0
  private retired: RhiBuffer[] = []

  constructor(
    private readonly rhi: RhiDevice,
    private readonly slotSize: number,
    initialCapacity: number,
    private readonly label: string,
    /** Rebuild the caller's bind group(s) against the (new) `buffer`.
     *  Invoked on first `ensure()` and after every grow. */
    private readonly onGrow: () => void,
  ) {
    this.capacity = initialCapacity
    this.staging = new Uint8Array(initialCapacity * slotSize)
    trackOwner(this, `UniformSlotArena ${label}`)
  }

  /** The live arena buffer as an RHI handle, or null before `ensure()`. */
  get rhiBuffer(): RhiBuffer | null {
    return this._buffer
  }

  /** Lazily create the arena buffer and build the caller's bind groups. */
  ensure(): void {
    if (this._buffer) return
    this._buffer = this.rhi.createBuffer({
      size: this.capacity * this.slotSize,
      usage: 'uniform',
      label: this.label,
    })
    this.onGrow()
  }

  /** Allocate a persistent slot (reusing freed slots first), growing the
   *  buffer if the high-water mark hits capacity. Returns the slot INDEX —
   *  stable until `free(slot)`. */
  alloc(): number {
    let slot: number
    const reused = this.freeList.pop()
    if (reused !== undefined) {
      slot = reused
    } else {
      if (this.next >= this.capacity) this.grow(this.next + 1)
      slot = this.next++
    }
    this.live.add(slot)
    return slot
  }

  /** Return a slot to the free list. Throws on a slot that is not live —
   *  a double-free means the caller's lifecycle bookkeeping is broken. */
  free(slot: number): void {
    if (!this.live.delete(slot))
      throw new Error(`[UniformSlotArena ${this.label}] free of non-live slot ${slot}`)
    this.freeList.push(slot)
  }

  /** Byte offset of a slot into the arena buffer (bind offset). */
  byteOffset(slot: number): number {
    return slot * this.slotSize
  }

  /** Number of currently-live (allocated, not freed) slots. */
  liveCount(): number {
    return this.live.size
  }

  /** Total slots the buffer currently holds. */
  capacitySlots(): number {
    return this.capacity
  }

  /** Copy a slot's uniform block into the staging mirror and extend the
   *  dirty range. `src` is clamped to the slot size. */
  stage(slot: number, src: ArrayBuffer): void {
    const offset = slot * this.slotSize
    const view = new Uint8Array(src, 0, Math.min(src.byteLength, this.slotSize))
    this.staging.set(view, offset)
    const hi = offset + this.slotSize
    if (this.dirtyHi === this.dirtyLo) {
      this.dirtyLo = offset
      this.dirtyHi = hi
    } else {
      if (offset < this.dirtyLo) this.dirtyLo = offset
      if (hi > this.dirtyHi) this.dirtyHi = hi
    }
  }

  /** Upload the accumulated dirty range as a single writeBuffer, then mark
   *  it empty. Safe to call multiple times per pass (no-op when clean). */
  flush(): void {
    if (this.dirtyHi === this.dirtyLo || !this._buffer) return
    this.rhi.writeBuffer(
      this._buffer,
      this.dirtyLo,
      this.staging.subarray(this.dirtyLo, this.dirtyHi),
    )
    this.dirtyLo = 0
    this.dirtyHi = 0
  }

  /** Hand the caller the buffers retired by grows since the last call, and
   *  clear the internal list (caller's disposal policy — ring parity). */
  takeRetired(): RhiBuffer[] {
    if (this.retired.length === 0) return []
    const r = this.retired
    this.retired = []
    return r
  }

  private grow(minSlots: number): void {
    let newCap = this.capacity
    while (newCap < minSlots) newCap *= 2
    if (this._buffer) {
      // Draws already recorded THIS pass may bind the OLD buffer at slot
      // offsets; push the pass's staged-but-unflushed range into it before
      // retiring so those draws don't read stale bytes (ring-grow parity).
      if (this.dirtyHi > this.dirtyLo) {
        this.rhi.writeBuffer(
          this._buffer,
          this.dirtyLo,
          this.staging.subarray(this.dirtyLo, this.dirtyHi),
        )
      }
      this.retired.push(this._buffer)
    }
    this.capacity = newCap
    this._buffer = this.rhi.createBuffer({
      size: newCap * this.slotSize,
      usage: 'uniform',
      label: this.label,
    })
    const grown = new Uint8Array(newCap * this.slotSize)
    grown.set(this.staging)
    this.staging = grown
    // PERSISTENT slots: the new buffer starts empty, so every byte written
    // so far must reach it — mark the whole used range dirty for the next
    // flush (the ring only re-uploads the current frame; the arena's
    // contents are its state).
    this.dirtyLo = 0
    this.dirtyHi = this.next * this.slotSize
    this.onGrow()
  }

  /** Full teardown: destroy the live buffer + any retired buffers. */
  destroy(): void {
    untrackOwner(this)
    if (this._buffer) this.rhi.destroyBuffer(this._buffer)
    this._buffer = null
    for (const r of this.retired) this.rhi.destroyBuffer(r)
    this.retired = []
  }
}
