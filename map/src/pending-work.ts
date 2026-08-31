// ═══ Pending-work registry — the single list of async resource classes (#2149) ═══
//
// "Is there still async scene content in flight?" was fed by hand-maintained per-class
// terms, and every new resource class had to remember to join — six recorded incidents
// (#1575 #1997 #2091 #2116 #2122 #2129) are that omission. This registry is the ONE list:
// a kind is added to PENDING_WORK_KINDS, registered in buildPendingWorkRegistry, and
// proven by the per-kind contract arms in pending-work.test.ts — the Record types make
// skipping either leg a compile error.
//
// GROWTH RULE (docs/architecture/convergence-authority.md §4.1/§5): the union grows one
// migration increment at a time; the design doc's twelve-kind table is the target
// inventory. Scopes and per-kind count projections arrive with their first consumers.
//
// BOUNDEDNESS is non-negotiable (#2091): every registered probe must stop counting past a
// deadline, so a host that accepts a connection and never answers costs one deadline of
// warm frames — never a map that idles no more. Probe-flavor kinds carry the deadline in
// their own ledger (glyph: GLYPH_INFLIGHT_KEEP_WARM_MS, glyph-pbf-cache.ts); ledger-flavor
// kinds carry it HERE, enforced centrally, so the class cannot register unbounded work.

/** A probe over the pending work of one kind. `count()` is O(1), allocation-free, and
 *  safe to call every rAF tick. 0 means drained. */
export interface PendingWorkSource {
  count(): number
}

/** One checked-out unit of ledger-flavor in-flight work. `done()` is idempotent, and a
 *  ticket the deadline already expired is a no-op to `done()` — it stopped counting on
 *  observation and never re-arms. */
export interface PendingWorkTicket {
  done(): void
}

/** The registered async resource classes. Growing per migration increment — see the
 *  header. Adding a kind here without a registration (and a contract fixture) is a
 *  compile error via the `Record<PendingWorkKind, …>` consumers. */
export const PENDING_WORK_KINDS = ['glyph', 'coverage'] as const
export type PendingWorkKind = (typeof PENDING_WORK_KINDS)[number]

/** The ledger-flavor subset of the union — kinds whose in-flight stamps the registry
 *  owns. `begin()` is only reachable for these. */
type PendingLedgerKind = 'coverage'

/** #2129 — how long one outstanding coverage catalogue-cell read holds the render loop
 *  awake. Sized off the shipped siblings, not invented: glyph and sprite in-flight are
 *  both 10 000 ms, the raster ledger abandons a tile after ~10.5 s. Past this deadline
 *  the ticket simply stops counting; the read itself is untouched, and a late arrival
 *  still repaints through the existing `invalidate()` at its commit site
 *  (`coverage-source.ts` armCatalogueItem) — mechanism (b) stays, this adds (a). */
const COVERAGE_INFLIGHT_KEEP_WARM_MS = 10_000

/** Registry-owned in-flight ledger (design §4.2, "ledger flavor"). Mirrors the glyph
 *  ledger's shape exactly (glyph-pbf-cache.ts hasPendingLoads): inclusive at the
 *  deadline boundary, expired entries pruned as they are observed so a hung host costs
 *  one deadline of warm frames once — not a growing map of dead keys. */
class PendingLedger implements PendingWorkSource {
  private readonly since = new Map<PendingWorkTicket, number>()
  constructor(private readonly deadlineMs: number) {}

  begin(): PendingWorkTicket {
    const ticket: PendingWorkTicket = { done: () => this.since.delete(ticket) }
    this.since.set(ticket, performance.now())
    return ticket
  }

  count(): number {
    if (this.since.size === 0) return 0
    const now = performance.now()
    let live = 0
    for (const [ticket, since] of this.since) {
      if (now - since <= this.deadlineMs) live++
      else this.since.delete(ticket)
    }
    return live
  }
}

/** The map members the registered probes read. A narrow structural view (the
 *  RenderLoopHost pattern) so this module names no XGISMap. */
export interface PendingWorkHost {
  textStage: { hasPendingGlyphLoads(): boolean } | null
}

export class PendingWorkRegistry {
  constructor(
    private readonly sources: Record<PendingWorkKind, PendingWorkSource>,
    private readonly ledgers: Record<PendingLedgerKind, PendingLedger>,
  ) {}

  /** True while ANY registered kind still counts in-flight work. Read by
   *  `shouldRenderThisFrame` every rAF tick: true keeps the loop warm, and every source
   *  is deadline-bounded, so a hung host releases the loop (#2091). */
  hasPending(): boolean {
    for (const kind of PENDING_WORK_KINDS) {
      if (this.sources[kind].count() > 0) return true
    }
    return false
  }

  /** Check one unit of ledger-flavor work out of the registry. The registry stamps it
   *  and enforces the kind's deadline centrally — the calling class cannot register
   *  unbounded work by construction. */
  begin(kind: PendingLedgerKind): PendingWorkTicket {
    return this.ledgers[kind].begin()
  }
}

/** Build the map's registry. Probes read `host` at CALL time (the stages are constructed
 *  lazily), so registration order vs. stage creation is irrelevant.
 *
 *  glyph (#2116, probe flavor): a label whose PBF range is still in flight draws
 *  metrics-only (all-zero SDF, correctly spaced and inkless), and the range lands on a
 *  network callback no tile/upload/LOD signal can see — without this probe `idle` means
 *  "converged except for text", which is how a settle-on-idle harness came to sample
 *  first-visit poses before their glyphs arrived. Bounded at the provider
 *  (GlyphProvider.hasPendingLoads → GlyphPbfCache's deadline-pruned in-flight set).
 *
 *  coverage (#2129, ledger flavor): a catalogue cell whose bytes are still being read was
 *  observable NOWHERE in the idle decision — the loop idled on a pre-coverage frame,
 *  `idle` fired, and every settle-on-idle harness sampled it. The cell read checks a
 *  ticket out around exactly the window `state.inFlight` spans
 *  (`coverage-source.ts` readCatalogueItem); Gate 10's mechanism (b) — `invalidate()` on
 *  arrival — stays for post-deadline landings. */
export function buildPendingWorkRegistry(host: PendingWorkHost): PendingWorkRegistry {
  const coverage = new PendingLedger(COVERAGE_INFLIGHT_KEEP_WARM_MS)
  return new PendingWorkRegistry(
    {
      glyph: { count: () => (host.textStage?.hasPendingGlyphLoads() ? 1 : 0) },
      coverage,
    },
    { coverage },
  )
}
