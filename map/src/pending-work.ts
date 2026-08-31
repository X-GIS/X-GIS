// ═══ Pending-work registry — the single list of async resource classes (#2149) ═══
//
// "Is there still async scene content in flight?" was answered in five drifting places,
// and every new resource class had to remember to join each of them — six recorded
// incidents (#1575 #1997 #2091 #2116 #2122 #2129) are that omission. This registry is the
// ONE list: a kind is added to PENDING_WORK_KINDS, registered in
// buildPendingWorkRegistry, and proven by the per-kind contract arms in
// pending-work.test.ts — the Record types make skipping either leg a compile error.
//
// GROWTH RULE (docs/architecture/convergence-authority.md §4.1/§5): the union grows one
// migration increment at a time; the design doc's twelve-kind table is the target
// inventory. Scopes, per-kind count projections and the ticket-ledger flavor arrive with
// their first consumers (increments 2+), not speculatively.
//
// BOUNDEDNESS is non-negotiable (#2091): every registered probe must stop counting past a
// deadline, so a host that accepts a connection and never answers costs one deadline of
// warm frames — never a map that idles no more. For probe-flavor kinds the deadline lives
// in the underlying ledger (glyph: GLYPH_INFLIGHT_KEEP_WARM_MS, glyph-pbf-cache.ts); the
// contract suite's past-deadline arm is the enforcement.

/** A probe over the pending work of one kind. `count()` is O(1), allocation-free, and
 *  safe to call every rAF tick. 0 means drained. */
export interface PendingWorkSource {
  count(): number
}

/** The registered async resource classes. Growing per migration increment — see the
 *  header. Adding a kind here without a registration (and a contract fixture) is a
 *  compile error via the `Record<PendingWorkKind, …>` consumers. */
export const PENDING_WORK_KINDS = ['glyph'] as const
export type PendingWorkKind = (typeof PENDING_WORK_KINDS)[number]

/** The map members the registered probes read. A narrow structural view (the
 *  RenderLoopHost pattern) so this module names no XGISMap. */
export interface PendingWorkHost {
  textStage: { hasPendingGlyphLoads(): boolean } | null
}

export class PendingWorkRegistry {
  constructor(private readonly sources: Record<PendingWorkKind, PendingWorkSource>) {}

  /** True while ANY registered kind still counts in-flight work. Read by
   *  `shouldRenderThisFrame` every rAF tick: true keeps the loop warm, and every source
   *  is deadline-bounded, so a hung host releases the loop (#2091). */
  hasPending(): boolean {
    for (const kind of PENDING_WORK_KINDS) {
      if (this.sources[kind].count() > 0) return true
    }
    return false
  }
}

/** Build the map's registry. Probes read `host` at CALL time (the stages are constructed
 *  lazily), so registration order vs. stage creation is irrelevant.
 *
 *  glyph (#2116): a label whose PBF range is still in flight draws metrics-only
 *  (all-zero SDF, correctly spaced and inkless), and the range lands on a network
 *  callback no tile/upload/LOD signal can see — without this probe `idle` means
 *  "converged except for text", which is how a settle-on-idle harness came to sample
 *  first-visit poses before their glyphs arrived. Bounded at the provider
 *  (GlyphProvider.hasPendingLoads → GlyphPbfCache's deadline-pruned in-flight set). */
export function buildPendingWorkRegistry(host: PendingWorkHost): PendingWorkRegistry {
  return new PendingWorkRegistry({
    glyph: { count: () => (host.textStage?.hasPendingGlyphLoads() ? 1 : 0) },
  })
}
