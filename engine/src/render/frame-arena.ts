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

import { DEV } from '@xgis/shared'

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
  /** DEV stale-view sentinel: the f32 NaN bit pattern. Regions whose views
   *  become ILLEGAL to retain (see `poisonRegion`) are filled with it, so a
   *  stale read yields loud NaN garbage instead of plausible previous-frame
   *  data (#783). A THROWING poison (Proxy-wrapped views) was evaluated and
   *  rejected: `ArrayBuffer.isView(Proxy(view))` is false, so a wrapped view
   *  breaks every native BufferSource consumer (GPU uploads, TypedArray.set
   *  fast paths) the moment it leaves arena-local code. */
  private static readonly POISON_U32 = 0x7fc00000

  /** DEV-only: scrub `[0, bytes)` of `buf` with the NaN sentinel. Called
   *  ONLY where view retention is illegal per the class contract — across
   *  `beginFrame()` and across `reserve()`. NOT called on the mid-frame
   *  auto-grow: reads through pre-grow views are documented-legal there
   *  (the old buffer still holds the copied bytes). Zero prod overhead. */
  private static poisonRegion(buf: ArrayBuffer, bytes: number): void {
    if (!DEV || bytes < 4) return
    new Uint32Array(buf, 0, bytes >>> 2).fill(FrameArena.POISON_U32)
  }

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
      // iter-251 — mid-frame auto-grow. Pre-iter-251 the arena
      // THREW on overflow, which caused runtime fatal errors on the
      // first frame where a peak exceeded the initial capacity
      // before beginFrame had a chance to grow. Now we grow + copy
      // the existing watermark contents into a new larger buffer.
      //
      // CAVEAT: existing views handed out earlier in THIS frame
      // become detached (their `.buffer` is the OLD ArrayBuffer
      // which is no longer this arena's backing store). Reads
      // through those views still work (they're typed-array views
      // over the old buffer which holds the data we just copied
      // — V8 keeps the old buffer alive while any view references
      // it), but WRITES through them do NOT reach the new buffer.
      // Caller code that mutates a view after another alloc fired
      // would be incorrect anyway — by spec the arena is bump-only
      // and downstream allocations may collide with upstream views.
      // No call site in X-GIS today mutates an old view after a
      // new alloc, so this is safe in practice.
      const newCap = Math.max(next * 2, Math.ceil(this.buffer.byteLength * FrameArena.GROW_FACTOR))
      const aligned16 = (newCap + 15) & ~15
      const newBuf = new ArrayBuffer(aligned16)
      new Uint8Array(newBuf).set(new Uint8Array(this.buffer, 0, this.watermark))
      this.buffer = newBuf
      this.grows++
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

  /** Allocate `count` Float64 slots (8 × count bytes, 8-byte aligned).
   *  Added iter-243 for VTR polyline xs/ys scratch — Float64 needed
   *  because polyline math accumulates mercator metre coords whose
   *  magnitude (±2e7) overflows Float32 precision at metre scale. */
  allocF64(count: number): Float64Array {
    const u8 = this.alloc(count * 8, 8)
    return new Float64Array(this.buffer, u8.byteOffset, count)
  }

  /** Pre-grow capacity to AT LEAST `bytes` total. No-op if already
   *  large enough. Use when a frame is about to make a known-large
   *  allocation that would otherwise overflow; calling reserve() at
   *  beginFrame time avoids the alloc-time throw. Discards the
   *  previous backing buffer — any in-flight sub-views become stale,
   *  so DO NOT call mid-frame. */
  reserve(bytes: number): void {
    if (bytes <= this.buffer.byteLength) return
    // Stale-view poison (#783): reserve discards the backing buffer, so any
    // in-flight view is dead. Scrub the old store so a retained view reads
    // loud NaN garbage in dev instead of silently-plausible stale data.
    FrameArena.poisonRegion(this.buffer, this.watermark)
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
    // Stale-view poison (#783): retaining a view across beginFrame is
    // illegal per the class contract — the watermark reset means this
    // frame's allocations ALIAS last frame's views (same bytes, new owners).
    // Scrub the used region so a retained view reads loud NaN garbage in
    // dev instead of last frame's still-plausible data. Covers both the
    // keep-buffer path (aliasing) and the grow path (old buffer discarded).
    FrameArena.poisonRegion(this.buffer, this.watermark)
    if (this.peak >= this.buffer.byteLength * FrameArena.GROW_TRIGGER) {
      const newCap = Math.max(16, (this.buffer.byteLength * FrameArena.GROW_FACTOR + 15) & ~15)
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
