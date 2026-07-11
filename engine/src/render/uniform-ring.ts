// ═══ UniformRing — growable per-draw uniform ring buffer ═══
//
// A generic GPU utility: one growable uniform buffer of fixed-size slots. Each
// draw stages its uniform block into a CPU mirror, and the accumulated dirty
// range is flushed as ONE writeBuffer per pass. Draws bind their slot via a
// dynamic offset into the shared buffer, so N draws in a pass need only a
// single upload instead of N. Backend-neutral: it creates, writes, and destroys
// exclusively through the RHI device port (RhiDevice / RhiBuffer), so it runs on
// any backend the RHI implements.
//
// The mid-pass grow path carries a correctness fix: when the slot cursor hits
// capacity mid-pass, draws already recorded this pass are bound to the OLD
// buffer at their slot offsets via dynamic offsets. Before retiring the old
// buffer for a larger one, this frame's staged slots are pushed into it, so
// those pre-grow draws don't read stale uniforms from a buffer the end-of-pass
// flush no longer targets.
//
// Caller policy stays with the caller, NOT this class:
//   - Bind-group rebuild on grow/create → the `onGrow` callback (the caller
//     rebuilds its own bind group(s) against the new `buffer`).
//   - Retired-buffer disposal → `takeRetired()`. The caller either drops the
//     refs (lets GC reclaim them after in-flight submits drain) or destroys
//     them at a safe point; each applies its own lifecycle policy.
//   - Grow instrumentation → the optional `onGrowStart` / `onGrowEnd` markers,
//     invoked at the boundaries of a grow so the caller can bracket its timing
//     (or observe grow frequency) without this class taking a profiling
//     dependency.

import type { RhiBuffer, RhiDevice } from '@xgis/rhi'

export class UniformRing {
  private _buffer: RhiBuffer | null = null
  private capacity: number
  private slot = 0
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
    /** Optional instrumentation markers, invoked at the start and end of a
     *  grow so the caller can bracket its timing (or count grows) without this
     *  class depending on a profiler. Absent = no instrumentation. */
    private readonly onGrowStart?: () => void,
    private readonly onGrowEnd?: () => void,
  ) {
    this.capacity = initialCapacity
    this.staging = new Uint8Array(initialCapacity * slotSize)
  }

  /** The live ring buffer as an RHI handle, or null before `ensure()` (#832 M2
   *  — backend-neutral; a WebGPU consumer that must bind the native buffer
   *  unwraps at ITS seam via WebGpuDevice.unwrapBuffer). */
  get rhiBuffer(): RhiBuffer | null {
    return this._buffer
  }

  /** Lazily create the ring buffer and build the caller's bind groups. */
  ensure(): void {
    if (this._buffer) return
    this._buffer = this.rhi.createBuffer({
      size: this.capacity * this.slotSize,
      usage: 'uniform',
      label: this.label,
    })
    this.onGrow()
  }

  /** Reset the slot cursor for a new frame. Retired disposal is the
   *  caller's policy — see `takeRetired()`. */
  resetSlot(): void {
    this.slot = 0
  }

  /** Hand the caller the buffers retired by grows since the last call, and
   *  clear the internal list. The caller destroys or drops them per its
   *  own lifecycle policy. */
  takeRetired(): RhiBuffer[] {
    if (this.retired.length === 0) return []
    const r = this.retired
    this.retired = []
    return r
  }

  /** Allocate the next slot, growing the ring if the cursor hit capacity.
   *  Returns the byte offset of the slot. */
  allocSlot(): number {
    if (this.slot >= this.capacity) this.grow(this.slot + 1)
    return this.slot++ * this.slotSize
  }

  /** Copy a draw's uniform block into the staging mirror at `offset` and
   *  extend the dirty range. */
  stageSlot(offset: number, src: ArrayBuffer): void {
    this.staging.set(new Uint8Array(src, 0, Math.min(src.byteLength, this.slotSize)), offset)
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
    const lo = this.dirtyLo,
      hi = this.dirtyHi
    // rhi.writeBuffer(buffer, offset, view) — the subarray view carries the
    // sub-range the (dataOffset, size) tail params expressed before; on WebGPU
    // this IS queue.writeBuffer, byte-identical.
    this.rhi.writeBuffer(this._buffer, lo, this.staging.subarray(lo, hi))
    this.dirtyLo = 0
    this.dirtyHi = 0
  }

  private grow(minSlots: number): void {
    this.onGrowStart?.()
    let newCap = this.capacity
    while (newCap < minSlots) newCap *= 2
    if (this._buffer) {
      // Draws already recorded THIS frame are bound to the OLD buffer at their
      // slot offsets via dynamic offsets. The end-of-pass flush writes only the
      // NEW buffer, so without this push the old buffer would still hold the
      // PREVIOUS frame's uniforms → pre-grow draws would read stale data. Push
      // this frame's staged slots into the old buffer before retiring it.
      if (this.slot > 0) {
        this.rhi.writeBuffer(this._buffer, 0, this.staging.subarray(0, this.slot * this.slotSize))
      }
      this.retired.push(this._buffer)
    }
    this.capacity = newCap
    this._buffer = this.rhi.createBuffer({
      size: newCap * this.slotSize,
      usage: 'uniform',
      label: this.label,
    })
    // Resize the CPU staging mirror in lockstep; preserve already-written
    // bytes so a grow mid-pass doesn't lose pending uniforms.
    const grown = new Uint8Array(newCap * this.slotSize)
    grown.set(this.staging.subarray(0, Math.min(this.staging.length, grown.length)))
    this.staging = grown
    this.onGrow()
    this.onGrowEnd?.()
  }

  /** Full teardown: destroy the live buffer + any retired buffers. */
  destroy(): void {
    if (this._buffer) this.rhi.destroyBuffer(this._buffer)
    this._buffer = null
    for (const r of this.retired) this.rhi.destroyBuffer(r)
    this.retired = []
  }
}
