// ═══ UniformRing — shared per-draw uniform ring buffer ═══
//
// Extracted from the byte-identical lifecycles in renderer.ts (MapRenderer)
// and vector-tile-renderer.ts (VTR). Both keep a growable GPU buffer of
// fixed-size slots, stage each draw's uniform block into a CPU mirror, and
// flush the dirty range as ONE writeBuffer per pass. The mid-pass grow path
// carries the iter-348 fix (push this frame's staged slots into the OLD
// buffer before retiring it, so pre-grow draws bound to it via dynamic
// offsets don't read stale uniforms) — previously this fix lived only in
// VTR, then was duplicated into MapRenderer; this class makes it single.
//
// Renderer-specific policy stays with the caller, NOT this class:
//   - Bind-group rebuild on grow/create → the `onGrow` callback (each
//     renderer rebuilds its own bind-group layout against `buffer`).
//   - Retired-buffer disposal → `takeRetired()`. VTR drops the refs (lets
//     GC reclaim them after in-flight submits drain — a deliberate race
//     fix); MapRenderer destroys them in beginFrame. Each applies its own
//     policy to the returned list.

export class UniformRing {
  private _buffer: GPUBuffer | null = null
  private capacity: number
  private slot = 0
  private staging: Uint8Array
  private dirtyLo = 0
  private dirtyHi = 0
  private retired: GPUBuffer[] = []

  constructor(
    private readonly device: GPUDevice,
    private readonly slotSize: number,
    initialCapacity: number,
    private readonly label: string,
    /** Rebuild the caller's bind group(s) against the (new) `buffer`.
     *  Invoked on first `ensure()` and after every grow. */
    private readonly onGrow: () => void,
  ) {
    this.capacity = initialCapacity
    this.staging = new Uint8Array(initialCapacity * slotSize)
  }

  /** The live GPU buffer, or null before `ensure()`. */
  get buffer(): GPUBuffer | null { return this._buffer }

  /** Lazily create the ring buffer and build the caller's bind groups. */
  ensure(): void {
    if (this._buffer) return
    this._buffer = this.device.createBuffer({
      size: this.capacity * this.slotSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: this.label,
    })
    this.onGrow()
  }

  /** Reset the slot cursor for a new frame. Retired disposal is the
   *  caller's policy — see `takeRetired()`. */
  resetSlot(): void { this.slot = 0 }

  /** Hand the caller the buffers retired by grows since the last call, and
   *  clear the internal list. The caller destroys or drops them per its
   *  own lifecycle policy. */
  takeRetired(): GPUBuffer[] {
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
    const lo = this.dirtyLo, hi = this.dirtyHi
    this.device.queue.writeBuffer(
      this._buffer, lo,
      this.staging.buffer, this.staging.byteOffset + lo, hi - lo,
    )
    this.dirtyLo = 0
    this.dirtyHi = 0
  }

  private grow(minSlots: number): void {
    let newCap = this.capacity
    while (newCap < minSlots) newCap *= 2
    if (this._buffer) {
      // iter-348 fix: draws already recorded THIS frame are bound to the
      // OLD buffer at their slot offsets via dynamic offsets. The end-of-
      // pass flush writes only the NEW buffer, so without this push the old
      // buffer would still hold the PREVIOUS frame's uniforms → pre-grow
      // draws render stale colours (the high-pitch "land painted water-
      // blue" transient). Push this frame's staged slots into the old
      // buffer before retiring it.
      if (this.slot > 0) {
        this.device.queue.writeBuffer(
          this._buffer, 0,
          this.staging.buffer, this.staging.byteOffset, this.slot * this.slotSize,
        )
      }
      this.retired.push(this._buffer)
    }
    this.capacity = newCap
    this._buffer = this.device.createBuffer({
      size: newCap * this.slotSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: this.label,
    })
    // Resize the CPU staging mirror in lockstep; preserve already-written
    // bytes so a grow mid-pass doesn't lose pending uniforms.
    const grown = new Uint8Array(newCap * this.slotSize)
    grown.set(this.staging.subarray(0, Math.min(this.staging.length, grown.length)))
    this.staging = grown
    this.onGrow()
  }

  /** Full teardown: destroy the live buffer + any retired buffers. */
  destroy(): void {
    this._buffer?.destroy()
    this._buffer = null
    for (const r of this.retired) r.destroy()
    this.retired = []
  }
}
