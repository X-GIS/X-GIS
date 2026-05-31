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
//   1. Free-list lookup: exact-footprint map `Map<align4(size), offset[]>`.
//      A pop() returns a reusable offset whose physical footprint EXACTLY
//      matches the request, so writeBuffer can never overrun the neighbour
//      allocation. O(1).
//   2. Bump pointer: when no free slot, advance `bumpPtr` by the
//      aligned size and return the previous bumpPtr. O(1).
//   3. Overflow check: if `bumpPtr + aligned > capacity`, throw
//      with a diagnostic naming the requested size.
//
// Free algorithm:
//
//   1. Round size up to the 4-byte boundary (align4).
//   2. Push offset onto that exact-size free list. O(1).
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
  /** Number of distinct exact-aligned sizes currently populated in the
   *  free-list. (Field name kept for API stability — formerly bucket
   *  count under the power-of-2 scheme.) */
  bucketCount: number
}

const ALIGN = 4

/** Round `bytes` up to the next 4-byte boundary. */
function align4(bytes: number): number {
  return (bytes + (ALIGN - 1)) & ~(ALIGN - 1)
}

// Free-list is keyed by align4(size): reuse only returns a slot whose
// physical footprint exactly matches the request, so writeBuffer can never
// overrun the neighbour allocation.

export class GPUArena {
  readonly buffer: GPUBuffer
  readonly capacityBytes: number
  private bumpPtr = 0
  private liveBytes = 0
  private allocCount = 0
  private freeCount = 0
  private reuseHits = 0
  /** Free-list keyed by EXACT align4(size). The value is a LIFO stack
   *  of free offsets of that exact aligned footprint. Identical-footprint
   *  reuse is required for correctness: bump advances by align4(bytes),
   *  so a freed slot occupies exactly align4(bytes) — reusing it for any
   *  larger request would overrun the neighbour. LIFO (push / pop)
   *  preserves GPU-cache locality during steady-state pan / zoom (same
   *  offsets reused frame after frame). */
  private freeList = new Map<number, number[]>()

  /** Bump high-water mark in bytes. Allocation-free O(1) field read.
   *  Gates the OOM throw, so this is the TRIGGER signal (overflow
   *  risk). NOTE: does NOT fall on free() — free() only repopulates
   *  the free-list — so it is the WRONG signal for the eviction loop. */
  get usedBytes(): number {
    return this.bumpPtr
  }
  pressure(): number {
    return this.bumpPtr / this.capacityBytes
  }
  /** In-flight bytes (alloc minus free). Allocation-free O(1) field
   *  read. FALLS on free(), so this is the eviction LOOP-TERMINATION
   *  signal (the value byte-pressure eviction can actually lower). */
  get liveUsedBytes(): number {
    return this.liveBytes
  }
  livePressure(): number {
    return this.liveBytes / this.capacityBytes
  }

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

    // 1. Try the exact-footprint free-list first. Reuse keys on the
    //    exact aligned footprint, so a popped slot is guaranteed to fit
    //    the request without overrunning its neighbour. Real tiles
    //    cluster around a few stride-aligned sizes per source-layer at a
    //    given zoom, so same-size reuse stays high in steady-state.
    const stack = this.freeList.get(aligned)
    if (stack !== undefined && stack.length > 0) {
      const offset = stack.pop()!
      this.liveBytes += aligned
      this.allocCount++
      this.reuseHits++
      return offset
    }

    // 2. Fall back to bump pointer. Overflow throws — caller is
    //    expected to size the arena for peak load. Auto-grow is
    //    a Phase 6a.5 follow-up. The throw path calls getStats() to
    //    enrich the diagnostic; this is the cold/failure path only, so
    //    the one object allocation introduces no per-frame churn and
    //    lets the crash site distinguish working-set overflow (free~0,
    //    live~capacity ⇒ raise capacity / byte-aware eviction) from
    //    fragmentation (free large, live small ⇒ reuse / compaction).
    if (this.bumpPtr + aligned > this.capacityBytes) {
      const s = this.getStats()
      throw new Error(
        `GPUArena.alloc: out of capacity. Requested ${bytes} (aligned ${aligned}) ` +
        `but only ${this.capacityBytes - this.bumpPtr} bytes remain ` +
        `(capacity ${this.capacityBytes}, bump ${this.bumpPtr}). ` +
        `live=${s.liveBytes} free=${s.freeBytes} ` +
        `reuseHits=${s.reuseHits} allocCount=${s.allocCount} freeCount=${s.freeCount}. ` +
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
   *  fragmentation leak (the slot goes onto the wrong exact-size key
   *  and never gets reused at its actual size) but can no longer
   *  corrupt memory — the failure mode degrades from CORRECTNESS to
   *  fragmentation-only. Tests pin the alloc/free symmetry. */
  free(offset: number, bytes: number): void {
    if (bytes <= 0) return  // silent no-op for caller convenience
    const aligned = align4(bytes)
    let stack = this.freeList.get(aligned)
    if (stack === undefined) {
      stack = []
      this.freeList.set(aligned, stack)
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

  /** O(1) serviceability probe: can a request of `bytes` be satisfied
   *  RIGHT NOW without eviction? True iff the exact-align4 free-list holds
   *  a same-footprint slot OR the bump region still has room. Unlike
   *  `getStats().freeBytes` (a SUM across all distinct exact-align4 size-
   *  keys), this is exact for a single request: with exact-size keying a
   *  free-list total of N bytes spread across mismatched footprints does
   *  NOT mean an align4(bytes) request is serviceable, but a populated
   *  stack at the matching key (or bump headroom) does. Allocation-free,
   *  so it is safe on the alloc-fail recovery path. */
  canServe(bytes: number): boolean {
    const aligned = align4(bytes)
    return (this.freeList.get(aligned)?.length ?? 0) > 0
      || this.bumpPtr + aligned <= this.capacityBytes
  }

  /** Reclaim the bump region IFF nothing is live. Safe because no
   *  outstanding offset can point into the reclaimed range — every
   *  alloc has been freed (liveBytes === 0). This is the only mid-
   *  session bump-pointer reclaim that is provably correct without
   *  defragmentation (full compaction stays the deferred Phase 6a.5
   *  item). Cheap O(1) check; callers invoke after eviction to relieve
   *  the fragmentation gap free() alone cannot — free() never lowers
   *  bumpPtr, so across zoom / source-layer a 66 MB bumpPtr stays
   *  pinned even when liveBytes is low. Returns true if a reclaim
   *  happened. */
  reclaimIfDrained(): boolean {
    if (this.liveBytes === 0 && this.bumpPtr > 0) {
      this.reset()
      return true
    }
    return false
  }

  /** Snapshot of allocator state for diagnostics + tests. The
   *  free-list is now keyed by EXACT align4(size), so freeBytes is
   *  exact: liveBytes + freeBytes ≤ bumpPtr holds exactly (was only
   *  an upper bound under the old bucket-space accounting). */
  getStats(): GPUArenaStats {
    let freeBytes = 0
    let bucketCount = 0
    for (const [size, stack] of this.freeList) {
      if (stack.length > 0) {
        bucketCount++
        freeBytes += size * stack.length
      }
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
