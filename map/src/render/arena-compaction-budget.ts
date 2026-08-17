// ═══ Arena compaction budget — what ONE post-submit maintenance pass may
//     relocate, and what it must not relocate at all (#1515) ═══
//
// THE HITCH THIS BOUNDS. `GpuTileStore._compactPolyArenas` relocates the live
// set of BOTH poly arenas in a single `runFrameMaintenance` call: a fresh
// full-capacity `createBuffer` (up to 128 MB vertex + 64 MB index, and WebGPU
// buffers are zero-initialised), one `copyBufferToBuffer` per resident tile per
// arena, then `bundleCache.invalidateAll()` so the next frame re-encodes every
// render bundle. Nothing bounded how often that ran, and nothing checked
// whether it could accomplish anything.
//
// The pathological case is the second half, and it is provable from the code
// rather than from a profile. `GPUArena.compact` finishes with
// `bumpPtr = liveBytes` (gpu-arena.ts) — the arena is then packed as tightly as
// a same-size repack can pack it, so a SECOND same-size repack provably
// reclaims zero bytes. But `GpuTileStore.forceEvictBytes` re-raises
// `_pendingArenaCompaction` on every alloc-fail it cannot serve and is not
// allowed to grow (at the auto-grow ceiling, or when the live set is not
// over-capacity), and nothing frees mid-frame. So under sustained arena
// pressure the store re-relocated the whole live set EVERY FRAME, each pass
// buying nothing and costing a full-capacity allocation plus a total bundle
// re-encode. That is a sustained freeze, not a one-off spike.
//
// TWO RULES, both pure policy (no GPU, no arena — exhaustively unit-testable):
//
//   1. FUTILITY GATE. A same-size repack is worth its cost only if it hands
//      back a meaningful number of bytes. `reclaimableBytes` (the gap between
//      the monotonic bump high-water mark and the live total — stranded
//      free-list plus the holes mismatched footprints left) is exactly that
//      quantity, and it is zero immediately after a compaction. Below
//      `MIN_RECLAIM_BYTES` the request is DROPPED, which restores the
//      documented at-ceiling behaviour (graceful skip-and-warn, the pre-grow
//      #218 path) instead of grinding.
//      An auto-grow request (US-003) is exempt: its point is the LARGER
//      destination buffer, not defragmentation, so zero reclaimable bytes must
//      not cancel it.
//
//   2. PER-PASS RELOCATION BUDGET. What survives the gate is charged against
//      `RELOCATION_BUDGET_BYTES`; what does not fit is DEFERRED and re-armed by
//      the caller for the next pass. A guaranteed FLOOR of one arena per pass
//      (the first runnable one runs however large it is) makes starvation
//      impossible, and the caller alternates which arena is charged first so
//      neither can be the perpetual loser. With two arenas that bounds any
//      pending set at two passes.
//
// WHY THE BUDGET IS PER-ARENA AND NOT PER-BYTE-RANGE. Splitting ONE arena's
// relocation across frames was considered and rejected: `compact()` swaps the
// backing buffer, and any allocation made between the first copy and the swap
// lands in the OLD buffer and is silently lost — so a staged intra-arena copy
// needs the destination to accept new allocations mid-flight, i.e. a full
// copying collector with a forwarding rule. That is a subsystem, not a budget,
// and it cannot be verified without a GPU. Arena granularity is what can be
// made correct by construction here; rule 1 is what actually removes the
// sustained cost.
//
// Layer: map/render policy — imports nothing.

/** One arena's pending relocation as the budget sees it. Structural on purpose:
 *  the policy never touches a `GPUArena`, so every branch below is reachable
 *  from a plain object in a unit test. */
export interface ArenaCompactionRequest {
  /** Bytes the relocation copy has to move — the arena's LIVE set, all of which
   *  is copied into the fresh destination buffer. This is the quantity the
   *  per-pass budget is charged against. */
  liveBytes: number
  /** Bytes a SAME-SIZE repack would hand back: bump high-water minus live.
   *  Zero right after a compaction (the arena is already packed). Ignored when
   *  `grow` is set. */
  reclaimableBytes: number
  /** True when this request carries an auto-grow target (US-003) — relocation
   *  into a LARGER buffer, which the futility gate must not cancel. */
  grow: boolean
}

/** What the pass should do with one arena's request.
 *  `run` — relocate now · `defer` — re-arm for the next pass (budget spent) ·
 *  `skip` — drop it; the relocation cannot accomplish anything. */
export type ArenaCompactionAction = 'run' | 'defer' | 'skip'

export interface ArenaCompactionPlan {
  vertex: ArenaCompactionAction
  index: ArenaCompactionAction
}

/** Futility floor for a SAME-SIZE repack. A repack costs a full-capacity buffer
 *  allocation plus a copy of the whole live set plus a total render-bundle
 *  re-encode, so it has to hand back enough headroom to actually serve the
 *  allocation that failed. One typical polygon vertex slot is ~250 KB at z=14
 *  (the arena sizing note in gpu-tile-store.ts), so 1 MiB ≈ four such slots is
 *  the smallest reclaim that can plausibly unblock an upload; below it the
 *  repack is pure cost. */
export const MIN_RECLAIM_BYTES = 1024 * 1024

/** Bytes one maintenance pass may relocate before deferring the rest.
 *
 *  MEASURED-PENDING (`playground/e2e/_1515-compaction-hitch-probe.spec.ts` is
 *  the instrument). The arithmetic the number comes from: relocation cost is
 *  dominated by the driver-side buffer copy, and the target is to keep a single
 *  pass under ~2 ms of the frame. At an integrated/mobile GPU copy bandwidth of
 *  ~20 GB/s that is ~40 MB; a discrete part at ~100 GB/s would allow ~200 MB.
 *  32 MiB takes the conservative arm with margin, and it is comfortably above
 *  the index arena's whole 64 MB capacity at any realistic live fill — so in
 *  practice the budget's effect is "do not relocate both poly arenas in the
 *  same pass unless they are jointly small", which is the bound available at
 *  arena granularity (see the header on why finer granularity was rejected).
 *  Re-derive from the probe's measured relocation throughput before tightening. */
export const RELOCATION_BUDGET_BYTES = 32 * 1024 * 1024

/** Decide what a single post-submit maintenance pass does with the two poly
 *  arenas' pending relocations.
 *
 *  `chargeIndexFirst` is the caller's alternating cursor: it picks which arena
 *  is charged against the budget first, and therefore which one wins the
 *  guaranteed floor. Flipping it every pass is what makes progress monotonic —
 *  without it a repeatedly-re-flagged vertex arena would defer the index arena
 *  forever. */
export function planArenaCompaction(
  vertex: ArenaCompactionRequest | null,
  index: ArenaCompactionRequest | null,
  chargeIndexFirst: boolean,
): ArenaCompactionPlan {
  const admit = (r: ArenaCompactionRequest | null): ArenaCompactionAction => {
    if (r === null) return 'skip'
    // Auto-grow is exempt from the futility gate: the destination buffer's
    // SIZE is the point, and a request for one can legitimately arrive with an
    // empty arena (a single allocation larger than the current capacity).
    if (r.grow) return 'run'
    if (r.liveBytes <= 0) return 'skip' // nothing to move; reclaimIfDrained covers it
    if (r.reclaimableBytes < MIN_RECLAIM_BYTES) return 'skip'
    return 'run'
  }
  const plan: ArenaCompactionPlan = { vertex: admit(vertex), index: admit(index) }

  const order = chargeIndexFirst ? (['index', 'vertex'] as const) : (['vertex', 'index'] as const)
  let spent = 0
  for (const slot of order) {
    if (plan[slot] !== 'run') continue
    const bytes = slot === 'vertex' ? vertex!.liveBytes : index!.liveBytes
    // FLOOR: whichever arena is charged first always runs, however large. There
    // is no smaller unit to split it into, so deferring it would defer it
    // forever; the floor is what turns the budget into a bound rather than a
    // deadlock.
    if (spent > 0 && spent + bytes > RELOCATION_BUDGET_BYTES) {
      plan[slot] = 'defer'
      continue
    }
    spent += bytes
  }
  return plan
}
