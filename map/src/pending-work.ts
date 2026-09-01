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
export const PENDING_WORK_KINDS = [
  'glyph',
  'sprite',
  'coverage',
  'raster-fetch',
  'raster-retry',
  'dem-fetch',
  'dem-retry',
  'vt-fetch',
  'vt-replaced',
  'vt-upload',
  'vt-missed',
  'vt-lod',
] as const
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
  iconStage: { hasPendingAtlasLoad(): boolean } | null
  /** The map's per-source registry — probes iterate it per count() call, the same
   *  O(sources) walk `hasPendingSourceWork` always did per tick. */
  vtSources: { values(): IterableIterator<VtPendingArm> }
  /** Definite-assignment fields on the map (`!`), so the probes optional-chain: before
   *  the GPU boots they are undefined at runtime and the kinds read 0. */
  rasterRenderer: TileLoadArm | undefined
  hillshadeRenderer: TileLoadArm | undefined
}

/** The slice of one attached vector-tile source the vt-* kinds read. Every probe is
 *  optional-guarded exactly as `hasPendingSourceWork` guarded it (a source mid-attach can
 *  lack a method), EXCEPT `_selection._czPendingAdvance`, reached directly for the reason
 *  render-loop-keep-warm.ts documented: the transition state has ONE owner
 *  (`TileSelectionCache`) and both owning files sit on shrink-only LOC ceilings, so the
 *  forwarder this would otherwise be cannot be added — the coupling is typechecked here
 *  instead. BOUNDS live with the owners and are pinned by their own suites: vt-fetch by
 *  tile-decision's KEEP_WARM_MAX_FAILURES (#1596, render-loop-keep-warm.test.ts),
 *  vt-lod by the readiness gate's reach-or-timeout contract (#2091/#2103,
 *  readiness-gate-unreachable-target.test.ts), vt-replaced by the swap applying on the
 *  next frame (#1448), vt-upload by the per-frame drain, vt-missed by the same #1596
 *  terminal-decision rule that stops counting an unfetchable tile. */
export interface VtPendingArm {
  source: {
    hasPendingLoads?(): boolean
    hasReplacedKeys?(): boolean
  }
  renderer: {
    hasPendingUploads?(): boolean
    getDrawStats?(): { missedTiles?: number }
    _selection: { _czPendingAdvance: unknown }
  }
}

/** The slice of a tile renderer (raster or DEM) the fetch/retry kinds read. Both
 *  probes are deadline-bounded in their OWN ledgers (tile-retry.ts): `pendingLoadCount`
 *  counts through `InflightLedger.liveCount()` (RASTER_INFLIGHT_KEEP_WARM_MS), and the
 *  retry ledger abandons a tile after MAX_TILE_ATTEMPTS (~10.5 s of backoff). */
export interface TileLoadArm {
  pendingLoadCount(): number
  failedTiles: { hasPendingRetries(): boolean }
}

/** A named kind subset — `hasPending(scope)` ORs only these. Declared next to the union
 *  so the two cannot be edited apart (the OVERLAY_PASSES precedent, pass-order.ts). */
export type PendingWorkScope = readonly PendingWorkKind[]

/** The four raster/DEM kinds (#2149 increment 4) — a named component of SCOPE_KEEP_WARM
 *  below, kept on its own so the scope tests can pin the family's identity directly. */
export const SCOPE_RASTER_DEM: PendingWorkScope = [
  'raster-fetch',
  'raster-retry',
  'dem-fetch',
  'dem-retry',
]

/** `keepLoopWarm`'s registry read (design §5.6) — the raster/DEM four plus the two VT
 *  signals the end-of-frame gate always scanned itself: `vt-upload` (#1575) and `vt-lod`
 *  (#1997 — the state every other signal is structurally blind to: the readiness gate
 *  advances the tile LOD one step per RENDERED frame, and an unconverged selection can be
 *  legitimately EMPTY, requesting/missing/uploading nothing in the exact frame the ramp
 *  still owes work; idling there is unrecoverable because the LOD and its 5 s timeout
 *  only advance inside a rendered frame). `vt-fetch`/`vt-replaced`/`vt-missed` are
 *  deliberately NOT here — the gate never read them: the fetch/swap signals reach
 *  `shouldRenderThisFrame` through the full-union read, and the missed count reaches the
 *  gate as its `totalMissed` input (the frame's OWN output — see KeepWarmInputs). */
export const SCOPE_KEEP_WARM: PendingWorkScope = [...SCOPE_RASTER_DEM, 'vt-upload', 'vt-lod']

/** EXACTLY `hasPendingSourceWork()`'s signal set (map.ts) — the cold-start burst's exit
 *  hysteresis consumes this scope so its semantics stay byte-for-byte (design non-goal:
 *  widening the burst signal set is a MEASURED decision deferred to #2150). vt-lod is
 *  deliberately NOT here: the burst never read it. */
export const SCOPE_VT_PIPELINE: PendingWorkScope = [
  'vt-fetch',
  'vt-replaced',
  'vt-upload',
  'vt-missed',
]

export class PendingWorkRegistry {
  constructor(
    private readonly sources: Record<PendingWorkKind, PendingWorkSource>,
    private readonly ledgers: Record<PendingLedgerKind, PendingLedger>,
  ) {}

  /** True while ANY registered kind still counts in-flight work. Read by
   *  `shouldRenderThisFrame` every rAF tick: true keeps the loop warm, and every source
   *  is deadline-bounded, so a hung host releases the loop (#2091). */
  hasPending(scope: PendingWorkScope = PENDING_WORK_KINDS): boolean {
    for (const kind of scope) {
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
 *  sprite (#2122, probe flavor): IconStage is built lazily on the first frame that needs
 *  it and its SpriteAtlasHost kicks off the atlas fetch WITHOUT arming `_needsRender`, so
 *  the next frame idles with icons unresolved and a fill-pattern still stubbed
 *  (`background-pattern-atlas.ts` records the symptom: "the async atlas landed on a
 *  frozen canvas"). Bounded at the host (SPRITE_INFLIGHT_KEEP_WARM_MS); `isAtlasTerminal()`
 *  is the WRONG probe — it answers the prepare-skip question and stays false forever
 *  against a host that accepts a connection and never answers (#2091, one class over).
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
      sprite: { count: () => (host.iconStage?.hasPendingAtlasLoad() ? 1 : 0) },
      coverage,
      // #1575/#1596 — the raster/DEM arms. Fetch counts are deadline-bounded in the
      // shared InflightLedger (a hung host stops counting at 10 s); retry counts are
      // bounded by MAX_TILE_ATTEMPTS in FailedTileLedger. Optional-chained: the
      // renderers are `!`-declared and undefined before the GPU boots.
      'raster-fetch': { count: () => host.rasterRenderer?.pendingLoadCount() ?? 0 },
      'raster-retry': {
        count: () => (host.rasterRenderer?.failedTiles.hasPendingRetries() ? 1 : 0),
      },
      'dem-fetch': { count: () => host.hillshadeRenderer?.pendingLoadCount() ?? 0 },
      'dem-retry': {
        count: () => (host.hillshadeRenderer?.failedTiles.hasPendingRetries() ? 1 : 0),
      },
      // The VT family (#1448 #1596 #1997) — one O(sources) walk per kind, early-exit,
      // mirroring hasPendingSourceWork's guards; bounds delegated per VtPendingArm's doc.
      'vt-fetch': {
        count: () => {
          for (const { source } of host.vtSources.values()) {
            if (source.hasPendingLoads?.()) return 1
          }
          return 0
        },
      },
      'vt-replaced': {
        count: () => {
          for (const { source } of host.vtSources.values()) {
            if (source.hasReplacedKeys?.()) return 1
          }
          return 0
        },
      },
      'vt-upload': {
        count: () => {
          for (const { renderer } of host.vtSources.values()) {
            if (renderer.hasPendingUploads?.()) return 1
          }
          return 0
        },
      },
      'vt-missed': {
        count: () => {
          let missed = 0
          for (const { renderer } of host.vtSources.values()) {
            missed += renderer.getDrawStats?.().missedTiles ?? 0
          }
          return missed
        },
      },
      'vt-lod': {
        count: () => {
          for (const { renderer } of host.vtSources.values()) {
            if (renderer._selection._czPendingAdvance !== null) return 1
          }
          return 0
        },
      },
    },
    { coverage },
  )
}
