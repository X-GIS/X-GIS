// ═══════════════════════════════════════════════════════════════════
// GPUArena — Phase 6a.1 (iter-207)
// ═══════════════════════════════════════════════════════════════════
//
// Linear arena allocator backing a single GPU buffer. Replaces the
// per-tile `acquireBuffer / releaseBuffer` pool (vector-tile-renderer.ts:
// 287-302) for use cases where all allocations target a SHARED GPU
// buffer — the precondition for `drawIndexedIndirect` (Phase 4 of the
// WebGPU roadmap).
//
// Why this exists (iter-206 investigation):
//
//   Current: per-tile `device.createBuffer({ size: polyVerts.byteLength,
//             usage: VERTEX | COPY_DST })` × ~12,600 buffers at z=14
//             OFM Bright. Each `pass.setVertexBuffer(0, ...)` swaps the
//             binding per tile (~300 swaps/frame for polygon fill alone).
//
//   With arena: one large GPU buffer (e.g. 64 MB). Tile uploads
//             `device.queue.writeBuffer(arena.buffer, offset, data)`.
//             Draw loop sets the arena buffer ONCE per show, then
//             issues `drawIndexed(count, 1, indexOffset/4,
//             vertexOffset/STRIDE)` per tile. Phase 4 collapses the
//             draw-loop into `drawIndexedIndirect` reading a single
//             argument buffer.
//
// What this module does NOT do (deferred to follow-up sub-phases):
//
//   - **Defragmentation.** Free-list grows fragmentation over a
//     long session. Initial implementation accepts this; Phase 6a.5
//     adds compaction during idle frames OR on alloc-fail.
//   - **Auto-grow.** Initial implementation throws on overflow
//     (caller pre-sizes capacity for the expected steady-state).
//     Phase 6a.5 adds `device.createBuffer` + `copyBufferToBuffer`
//     growth.
//   - **GPU resource management beyond the single buffer.** Bind
//     groups, pipelines, etc. stay at the VTR layer.
//
// Allocation algorithm:
//
//   1. Free-list lookup: size-bucket map `Map<bucketSize, offset[]>`
//      where bucketSize is the next-power-of-2 of the request. A
//      pop() returns a reusable offset. O(1).
//   2. Bump pointer: when no free slot, advance `bumpPtr` by the
//      aligned size and return the previous bumpPtr. O(1).
//   3. Overflow check: if `bumpPtr + aligned > capacity`, throw
//      with a diagnostic naming the requested size.
//
// Free algorithm:
//
//   1. Round size up to bucket boundary.
//   2. Push offset onto the bucket's free list. O(1).
//   3. Active byte counter decremented. (Used for stats.)
//
// Alignment:
//
//   WebGPU requires 4-byte alignment for `setVertexBuffer` /
//   `setIndexBuffer` offsets. Arena enforces 4-byte alignment on
//   every alloc by rounding the request size up to a multiple of 4.
//   Callers don't need to pre-align their byte lengths.

/** Configuration for a new arena. */
export interface GPUArenaOptions {
  /** Initial buffer capacity in bytes. Allocations beyond this throw
   *  (Phase 6a.5 will add auto-grow). Recommended: estimated peak
   *  + 25 % headroom. */
  capacityBytes: number
  /** WebGPU usage flags for the underlying buffer. Typical:
   *  `GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST` for a vertex
   *  arena. */
  usage: GPUBufferUsageFlags
  /** Optional label propagated to `device.createBuffer({ label })`.
   *  Helps the WebGPU validation messages + DevTools attribution. */
  label?: string
}

/** Lightweight subset of GPUDevice used by GPUArena. Real device
 *  provides this; tests can substitute a stub. */
export interface GPUArenaDevice {
  createBuffer(desc: GPUBufferDescriptor): GPUBuffer
}

/** Allocator diagnostics. Read via `getStats()`. */
export interface GPUArenaStats {
  /** Total bytes alloc'd (active + free-list) — equals bumpPtr. */
  totalAllocatedBytes: number
  /** Bytes currently in flight (not in free-list). */
  liveBytes: number
  /** Bytes currently in the free-list — fragmentation indicator. */
  freeBytes: number
  /** Number of alloc() calls since construction. */
  allocCount: number
  /** Number of free() calls since construction. */
  freeCount: number
  /** Number of free-list reuse hits (vs bump-pointer extends). */
  reuseHits: number
  /** Number of distinct bucket sizes currently populated. */
  bucketCount: number
}

const ALIGN = 4

/** Round `bytes` up to the next 4-byte boundary. */
function align4(bytes: number): number {
  return (bytes + (ALIGN - 1)) & ~(ALIGN - 1)
}

/** Round `bytes` up to the next power-of-2 boundary, minimum 16 B.
 *  Bucket assignment for the free-list. Minimum prevents pathological
 *  fragmentation on tiny allocations (e.g. 4 B index updates). */
function bucketSize(bytes: number): number {
  if (bytes <= 16) return 16
  let p = 16
  while (p < bytes) p *= 2
  return p
}

export class GPUArena {
  readonly buffer: GPUBuffer
  readonly capacityBytes: number
  private bumpPtr = 0
  private liveBytes = 0
  private allocCount = 0
  private freeCount = 0
  private reuseHits = 0
  /** Free-list keyed by size-bucket (power of 2, min 16 B). The value
   *  is an array of free offsets in that bucket. LIFO stack semantics
   *  (push / pop) so recently-freed slots are preferred — improves
   *  GPU cache locality during steady-state pan / zoom (same offsets
   *  reused frame after frame). */
  private freeList = new Map<number, number[]>()

  constructor(device: GPUArenaDevice, opts: GPUArenaOptions) {
    this.buffer = device.createBuffer({
      size: opts.capacityBytes,
      usage: opts.usage,
      label: opts.label,
    })
    this.capacityBytes = opts.capacityBytes
  }

  /** Allocate `bytes` from the arena. Returns the byte offset into
   *  `this.buffer` where the caller can write. Throws when the request
   *  exceeds remaining capacity. */
  alloc(bytes: number): number {
    if (bytes <= 0) {
      throw new Error(`GPUArena.alloc: bytes must be positive (got ${bytes})`)
    }
    const aligned = align4(bytes)
    const bucket = bucketSize(aligned)

    // 1. Try free-list bucket first. Same-size reuse hits ~95 % of
    //    requests in steady-state (tiles tend to repeat their byte
    //    lengths within a source-layer at a given zoom).
    const stack = this.freeList.get(bucket)
    if (stack !== undefined && stack.length > 0) {
      const offset = stack.pop()!
      this.liveBytes += aligned
      this.allocCount++
      this.reuseHits++
      return offset
    }

    // 2. Fall back to bump pointer. Overflow throws — caller is
    //    expected to size the arena for peak load. Auto-grow is
    //    a Phase 6a.5 follow-up.
    if (this.bumpPtr + aligned > this.capacityBytes) {
      throw new Error(
        `GPUArena.alloc: out of capacity. Requested ${bytes} (aligned ${aligned}) ` +
        `but only ${this.capacityBytes - this.bumpPtr} bytes remain ` +
        `(capacity ${this.capacityBytes}, bump ${this.bumpPtr}). ` +
        `Increase capacity OR free() unused allocations.`,
      )
    }
    const offset = this.bumpPtr
    this.bumpPtr += aligned
    this.liveBytes += aligned
    this.allocCount++
    return offset
  }

  /** Return a previously-alloc'd range to the free-list. `bytes`
   *  MUST match the SAME bytes value passed to alloc (the arena
   *  doesn't track per-offset sizes — it would double memory cost
   *  and offers no safety benefit when callers already pair
   *  alloc/free symmetrically).
   *
   *  Calling free() with a mismatched `bytes` produces a silent
   *  fragmentation leak (the slot goes onto the wrong bucket and
   *  never gets reused at its actual size). Tests pin the
   *  alloc/free symmetry. */
  free(offset: number, bytes: number): void {
    if (bytes <= 0) return  // silent no-op for caller convenience
    const aligned = align4(bytes)
    const bucket = bucketSize(aligned)
    let stack = this.freeList.get(bucket)
    if (stack === undefined) {
      stack = []
      this.freeList.set(bucket, stack)
    }
    stack.push(offset)
    this.liveBytes -= aligned
    this.freeCount++
  }

  /** Reset the arena to its initial empty state. Use when the source
   *  is fully replaced (setSourceData) or the map is torn down —
   *  the GPU buffer survives, only the bookkeeping is cleared. */
  reset(): void {
    this.bumpPtr = 0
    this.liveBytes = 0
    this.freeList.clear()
    // allocCount / freeCount / reuseHits stay monotonic for diagnostics.
  }

  /** Destroy the underlying GPU buffer + clear bookkeeping. Use on
   *  map disposal. Calling alloc() after destroy is undefined
   *  behaviour (the GPUBuffer ref stays but is destroyed driver-side). */
  destroy(): void {
    this.buffer.destroy()
    this.bumpPtr = 0
    this.liveBytes = 0
    this.freeList.clear()
  }

  /** Snapshot of allocator state for diagnostics + tests. */
  getStats(): GPUArenaStats {
    let freeBytes = 0
    let bucketCount = 0
    for (const stack of this.freeList.values()) {
      if (stack.length === 0) continue
      bucketCount++
      // freeBytes is an upper bound — we know the bucket size + count
      // but not necessarily the original request size of each entry.
      // Use the bucket size as the storage size (matches the bump
      // pointer accounting since alloc bumped by aligned ≤ bucketSize).
      // Note: alloc bumps by `aligned` (e.g. 12 → 12), but the bucket
      // assignment uses next-pow2 (12 → 16). The free-list operates
      // in bucket-space so freeBytes reflects bucket-space too.
      // Live + free WILL NOT equal bumpPtr unless every bytes-arg was
      // already power-of-2 aligned. That's expected; getStats is
      // diagnostic.
      // Iterate keys for the size term.
    }
    for (const [size, stack] of this.freeList) {
      if (stack.length > 0) freeBytes += size * stack.length
    }
    return {
      totalAllocatedBytes: this.bumpPtr,
      liveBytes: this.liveBytes,
      freeBytes,
      allocCount: this.allocCount,
      freeCount: this.freeCount,
      reuseHits: this.reuseHits,
      bucketCount,
    }
  }
}
