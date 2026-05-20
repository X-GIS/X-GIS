// ═══════════════════════════════════════════════════════════════════
// FrameArena — Plan AAA Phase B.1 (iter-239)
// ═══════════════════════════════════════════════════════════════════
//
// CPU-side linear bump allocator. Single ArrayBuffer, watermark
// pointer, reset on each `beginFrame()`. Per-frame transient buffers
// (shaping scratch, layout intermediates, sort keys, projection
// scratch) carve sub-views from this single backing store instead of
// each allocating their own `new Float32Array(N)` / `new Uint8Array(N)`
// per frame.
//
// Why this exists (iter-235 / iter-236 / iter-237 work)
//
// The C.1 heap-delta diagnostic (iter-235) measured ~665 KB/f
// allocation at idle on Bright z=14 Seoul. iter-236 / iter-237
// hoisted three per-frame Map/Set allocations to scratch fields,
// pulling Seoul down to ~348 KB/f. The remaining heap pressure is
// dominated by typed-array allocations:
//
//   - per-show Float32Array projection scratch (map.ts:4526-4527
//     `_pxScratch` / `_pyScratch` — already grow-but-don't-shrink,
//     but per-show instantiation when sizes spike)
//   - text-stage glyph-position arrays per label
//   - line-label polyline xs/ys arrays
//   - bundle / draw-queue argument arrays
//
// A frame allocator collapses all of these into ONE persistent
// ArrayBuffer that grows monotonically to the per-session peak, then
// resets the watermark each frame. Steady-state allocation rate
// drops to zero (the arena is reused; only the watermark changes).
//
// Design notes
//
//   - Bump allocator only — no per-allocation free. Free granularity
//     is whole-arena via `beginFrame()`. Callers that need cross-frame
//     persistence must use a different store (scratch fields, GPU
//     uploads, etc.).
//
//   - 4-byte alignment by default (matches Float32Array / Uint32Array
//     stride). Caller can pass higher align (16, 256) for WGSL-uniform
//     style padding.
//
//   - Capacity grows 1.5× when peak watermark hits 0.9× of current
//     capacity over multiple frames. Growth ALWAYS at `beginFrame()` —
//     never mid-frame, so existing sub-views remain valid through the
//     in-flight frame.
//
//   - Sub-views are typed-array views into the backing ArrayBuffer.
//     They share underlying memory; mutating one mutates the buffer.
//     Caller responsibility: don't alias overlapping allocations.
//
//   - Stats (`getStats()`) expose `capacity`, `peakBytes` (high-water
//     mark across frame lifetime), `usedBytes` (this-frame watermark).
//     Plug into StatsTracker / StatsPanel for visibility.
//
// What this does NOT do
//
//   - Cross-frame lifetime (use a class field or arena instance pool).
//   - Free of specific sub-allocations (whole-frame free only).
//   - Concurrent allocation (single-threaded; renderFrame is sync).
//   - GPU-resident memory (use GPUArena for that — different problem).

export interface FrameArenaStats {
  /** Current backing ArrayBuffer size in bytes. */
  capacityBytes: number
  /** Bytes allocated this frame (watermark). */
  usedBytes: number
  /** Peak watermark observed across frame lifetime. Drives capacity grow. */
  peakBytes: number
  /** Lifetime count of `beginFrame()` calls. */
  frames: number
  /** Lifetime count of capacity grow events. */
  grows: number
}

export class FrameArena {
  private buffer: ArrayBuffer
  private watermark = 0
  private peak = 0
  private frames = 0
  private grows = 0
  /** Capacity-grow threshold ratio. peak / cap >= GROW_TRIGGER triggers
   *  1.5× grow at next `beginFrame()`. Keeps an empty headroom above
   *  the steady-state peak so allocations don't oscillate at the cap. */
  private static readonly GROW_TRIGGER = 0.9
  private static readonly GROW_FACTOR = 1.5

  constructor(initialBytes: number = 64 * 1024) {
    // Round to multiple of 16 for WGSL-friendly alignment.
    const cap = Math.max(16, (initialBytes + 15) & ~15)
    this.buffer = new ArrayBuffer(cap)
  }

  /** Bump-allocate `bytes` of arena memory at the next aligned offset.
   *  Returns a `Uint8Array` view; cast to a typed-array view via
   *  `allocF32` / `allocU32` etc. when the caller knows the element
   *  type. Throws if `bytes` exceeds remaining capacity — caller
   *  should call `beginFrame()` first or grow the arena pre-emptively.
   *
   *  Alignment defaults to 4 bytes (Float32Array / Uint32Array stride).
   *  Pass 16 for vec4 / WGSL uniform-padded data. */
  alloc(bytes: number, align: number = 4): Uint8Array {
    // Power-of-2 alignment expected; mask = align - 1.
    const aligned = (this.watermark + align - 1) & ~(align - 1)
    const next = aligned + bytes
    if (next > this.buffer.byteLength) {
      throw new RangeError(
        `FrameArena overflow: alloc(${bytes}, align=${align}) at watermark ${this.watermark} `
        + `would push past capacity ${this.buffer.byteLength}. Call beginFrame() first or `
        + `pre-grow via reserve().`,
      )
    }
    this.watermark = next
    return new Uint8Array(this.buffer, aligned, bytes)
  }

  /** Allocate `count` Float32 slots (4 × count bytes, 4-byte aligned). */
  allocF32(count: number): Float32Array {
    const u8 = this.alloc(count * 4, 4)
    return new Float32Array(this.buffer, u8.byteOffset, count)
  }

  /** Allocate `count` Uint32 slots (4 × count bytes, 4-byte aligned). */
  allocU32(count: number): Uint32Array {
    const u8 = this.alloc(count * 4, 4)
    return new Uint32Array(this.buffer, u8.byteOffset, count)
  }

  /** Allocate `count` Int32 slots (4 × count bytes, 4-byte aligned). */
  allocI32(count: number): Int32Array {
    const u8 = this.alloc(count * 4, 4)
    return new Int32Array(this.buffer, u8.byteOffset, count)
  }

  /** Pre-grow capacity to AT LEAST `bytes` total. No-op if already
   *  large enough. Use when a frame is about to make a known-large
   *  allocation that would otherwise overflow; calling reserve() at
   *  beginFrame time avoids the alloc-time throw. Discards the
   *  previous backing buffer — any in-flight sub-views become stale,
   *  so DO NOT call mid-frame. */
  reserve(bytes: number): void {
    if (bytes <= this.buffer.byteLength) return
    const cap = Math.max(16, (bytes + 15) & ~15)
    this.buffer = new ArrayBuffer(cap)
    this.watermark = 0
    this.grows++
  }

  /** Reset the watermark for a new frame. Capacity grow happens here
   *  when the previous frame's peak hit GROW_TRIGGER × capacity.
   *  In-flight sub-views from the previous frame are invalidated;
   *  callers must NOT retain typed-array refs across `beginFrame()`. */
  beginFrame(): void {
    if (this.watermark > this.peak) this.peak = this.watermark
    if (this.peak >= this.buffer.byteLength * FrameArena.GROW_TRIGGER) {
      const newCap = Math.max(
        16,
        ((this.buffer.byteLength * FrameArena.GROW_FACTOR) + 15) & ~15,
      )
      this.buffer = new ArrayBuffer(newCap)
      this.grows++
    }
    this.watermark = 0
    this.frames++
  }

  /** Diagnostic snapshot. */
  getStats(): FrameArenaStats {
    return {
      capacityBytes: this.buffer.byteLength,
      usedBytes: this.watermark,
      peakBytes: this.peak,
      frames: this.frames,
      grows: this.grows,
    }
  }
}
