// ═══ End-of-frame keep-warm gate ═══
//
// Tile/texture work still outstanding keeps the loop warm so the scene converges. Pure
// and extracted (#1575) because this predicate is the difference between a map that
// converges and one that fossilises half-loaded, and it was previously reachable only
// through a full GPU frame — the exact shape CLAUDE.md's own lessons ledger records as
// having been paid for once already.

import { SCOPE_KEEP_WARM, type PendingWorkRegistry } from './pending-work'

export interface KeepWarmInputs {
  /** Unresolved VT placeholders counted this frame — the frame's OWN output, summed by
   *  the loop over `hasData()` sources only, so it stays a direct input rather than a
   *  `vt-missed` registry re-read (that probe has no hasData() skip; routing through it
   *  would widen the signal). A failing VT tile reaches this gate ONLY here, and the
   *  bound is tile-decision's KEEP_WARM_MAX_FAILURES: past it the decision turns
   *  terminal and the renderer stops counting the miss (#1596). */
  totalMissed: number
  /** #2149 increment 6 — every other signal (raster/DEM mid-fetch + retry backoff, VT
   *  deferred uploads, a VT LOD ramp in flight) is a registered pending-work kind, read
   *  through ONE scope; the per-kind reasons and bounds live on the registrations
   *  (pending-work.ts) and the scope's own doc. The composed chain (#2158: this →
   *  _needsRender → shouldRenderThisFrame's first term) is unchanged. */
  pendingWork: Pick<PendingWorkRegistry, 'hasPending'>
}

/** Must the loop render again? `totalMissed` plus the SCOPE_KEEP_WARM kinds. The
 *  hand-maintained per-class signal list this gate accreted between #1575 and #2091 is
 *  gone: a new resource class joins by REGISTERING (pending-work.ts), and membership in
 *  this end-of-frame read is decided once, at the scope declaration — not by editing a
 *  second list here. `totalMissed` short-circuits first, so the O(sources) VT walks
 *  behind the scope run only when the cheap signal is quiet (the ordering the old
 *  hand-rolled body also kept). */
export function keepLoopWarm(input: KeepWarmInputs): boolean {
  return input.totalMissed > 0 || input.pendingWork.hasPending(SCOPE_KEEP_WARM)
}
