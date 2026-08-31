# Convergence authority — one registry for "is the scene converged?" (#2149)

Status: **APPROVED 2026-08-31** (owner, "허가" — blanket approval of the doc as written,
including §9's three recommendations: 10 s deadline default, #2129 lands on the new rails
in increment 2, burst scope stays `SCOPE_VT_PIPELINE` pending #2150's measurement).
**Reconciled 2026-08-31, same day, against the owner's parallel corrections on main**:
#2158 (composed-authority framing — see §1 ⚠), #2161 (Gate 10 = L3, landed — see §4.5),
#2162/#2163 (`getMissingTileCount` is not a convergence signal — see §4.3). One new owner
decision opened and then settled the same day: §9.4 (coverage — (a), second "허가");
increment 2 landed on it.
Date: 2026-08-31. Tracking issue: #2149. Origin: marathon roadmap Phase 5, first bullet
(`docs/plans/2026-08-25-marathon-roadmap.md:179-192`).

## 1. Problem

Six recorded incidents share one shape — a new async resource class forgot to join the
convergence predicates, so `idle` fired before the scene landed, or the loop never idled:

| incident         | class                    | failure                                                   |
| ---------------- | ------------------------ | --------------------------------------------------------- |
| #1575            | raster/DEM retry backoff | loop idled before the retry ran; permanent black relief   |
| #1997            | VT LOD advance           | selection stuck behind the camera after multi-level jumps |
| #2091            | readiness target         | the inverse: an unbounded signal → never-idle wedge       |
| #2116 / PR #2120 | glyph PBF ranges         | `idle` = "converged except for text"                      |
| #2122 / PR #2126 | sprite atlas             | same hole, "one resource class over"                      |
| #2129 (open)     | coverage cell reads      | same hole, third instance                                 |

⚠ **Framing corrected 2026-08-31** (owner, #2158, after this doc was approved): the sites
below are **composed, not competing** — `keepLoopWarm` → `_needsRender`
(`render-loop.ts:682`) → `shouldRenderThisFrame`'s first term; `hasPendingSourceWork` is a
private helper `shouldRenderThisFrame` calls; `awaitMapIdle` decides nothing (it reads the
event bus's `_wasIdle`). There is ONE composed authority. What survives — and what this
design's registry delivers — is #2158's surviving core: **nothing enumerates the async
resource classes**, so each new class was a human noticing an omission. "Collapse the
predicates" is NOT the goal; "make the class list the single registered thing" is.

The question "is there still work pending?" is fed from **five composed sites, each
holding a hand-maintained partial signal list**:

1. `shouldRenderThisFrame()` — `map/src/map.ts:4423-4493`, an open enumeration grown one
   incident at a time;
2. `hasPendingSourceWork()` — `map/src/map.ts:4512-4528`, VT sources only; also the
   cold-start burst exit signal (`map-cold-start-burst.ts`);
3. `keepLoopWarm()` — `map/src/render-loop-keep-warm.ts:70-83`, six signals, one reached
   through `_selection._czPendingAdvance` because the owning files sit at LOC ceilings;
4. `_missingTileCount` — `map/src/render-loop.ts:659-666`, a **manual re-sum** of "the same
   three signals the keep-warm gate ORs" (its own comment), feeding public
   `getMissingTileCount()`;
5. `awaitMapIdle` — `playground/e2e/helpers/visual.ts:626`, the e2e settle authority
   (#2101 was its instance of the same defect).

Every fix so far is the same fix: _remember to add a term_. The bug class is structural;
the durable fix is structural.

## 2. Goals and non-goals

**Goals**

- G1 — ONE registry of async resource classes ("pending-work kinds") that every
  convergence consumer derives from.
- G2 — **bounded by construction**: an unbounded registration is unrepresentable or fails
  a generated contract test; the #2091 wedge cannot be reintroduced by omission.
- G3 — forgetting to register is loud: a compile error where the type system can see it, a
  ratchet where it cannot (stated honestly in §4.5 — no overclaim).
- G4 — zero per-frame allocation; O(kinds) with O(1) probes (the predicate runs every rAF
  tick).
- G5 — **signal-preserving migration**: each increment moves a term without changing when
  `idle` fires; §5 render gates prove sampling points did not move.

**Non-goals**

- Animation keep-alives (camera animation, paint transitions, symbol fade, raster/DEM
  cross-fade, particle drift, IBFV flow) stay OUT. They answer "keep animating", not
  "is content landed"; each settles through its own ledger by design. `idle` still sees
  them via Q1 below — unchanged.
- No change to burst-exit semantics: the burst keeps exactly today's signal set through a
  scope (§4.3); widening it is a **measured** decision deferred to the TTFM instrument
  (#2150).
- Nothing moves into `engine/` (§7 Q5).
- No render-graph / scheduler work (see `docs/architecture/render-graph-pass-scheduler.md`
  for that ruling).

## 3. The two questions, and today's wiring

- **Q2 — data-convergence**: "is all async scene content landed?" Fetches in flight
  (VT / raster / DEM / glyphs / sprites / coverage), deferred uploads, owed transitions
  (replaced keys #1448, LOD advance #1997), unresolved placeholders (missed tiles).
- **Q1 — render-continuation**: "must the loop render another frame?" = Q2 ∪ animation
  keep-alives ∪ camera/canvas signature diff.

`idle` is derived in exactly one place — `map-event-bus.ts:131-138`:
`idleNow = !move && !zoom && !shouldRenderThisFrame()` — so Q1 is already the idle
authority and Q2 feeds it. The defect is that **Q2 has no single source**: sites 2–4 are
three partial copies of it, and site 1 embeds a fourth. This design gives Q2 one source
and turns sites 1–4 into projections of it. Site 5 (`awaitMapIdle`) is already a pure
consumer of `idle` + `getMissingTileCount()` and needs no change — its honesty improves
transitively.

## 4. Proposed design

New module `map/src/pending-work.ts` (content package — the classes are content; see §7
Q5). Names are proposals, not contracts.

### 4.1 The closed kind union — the single list

```ts
export const PENDING_WORK_KINDS = [
  'vt-fetch', // source.hasPendingLoads()            (site 2)
  'vt-replaced', // source.hasReplacedKeys()      #1448 (site 2)
  'vt-upload', // renderer.hasPendingUploads()        (sites 2,3)
  'vt-missed', // missedTiles > 0                     (sites 2,3,4)
  'vt-lod', // _czPendingAdvance !== null    #1997 (site 3)
  'raster-fetch', // rasterRenderer.pendingLoadCount()   (sites 3,4)
  'raster-retry', // failedTiles.hasPendingRetries #1575 (site 3)
  'dem-fetch', // hillshadeRenderer.pendingLoadCount() (sites 3,4)
  'dem-retry', //                               #1575 (site 3)
  'glyph', // textStage.hasPendingGlyphLoads #2116 (site 1)
  'sprite', // iconStage.hasPendingAtlasLoad  #2122 (site 1)
  'coverage', // in-flight catalogue cell reads #2129 (nowhere yet)
] as const
export type PendingWorkKind = (typeof PENDING_WORK_KINDS)[number]
```

Twelve kinds; the table above is the complete inventory of what sites 1–4 read today plus
the one hole #2129 documents. Anything found missing during migration is added to the
union — which is the point: adding it here forces every `Record<PendingWorkKind, …>` in
the codebase to acknowledge it at compile time.

### 4.2 Source contract — two flavors, one enforcement

```ts
/** A probe over pending work of one kind. count() is O(1), allocation-free, and safe to
 *  call every rAF tick. 0 means drained. */
export interface PendingWorkSource {
  count(): number
}
```

- **Ledger flavor** (default for NEW classes, e.g. `coverage`): the registry owns the
  in-flight ledger. The class checks tickets out and back in
  (`registry.begin(kind)` → stamp; `done()` idempotent); expiry is **central** — a ticket
  older than the kind's deadline stops counting and is pruned on observation. A class
  using this flavor _cannot_ register unbounded work: the deadline is not its code.
- **Probe flavor** (adapter over an EXISTING bounded ledger, e.g. `raster-retry` over
  `failedTiles`, `glyph` over `TextStage.hasPendingGlyphLoads`): a closure created at
  registration time in `map.ts` (which already holds every renderer/stage — no new
  imports in ceiling-locked files, §7 Q3). Boundedness is enforced by the contract suite
  (§4.5 L2), not by the type — stated honestly: the type system cannot see a deadline.

Deadline default: **10 s**, sized off the shipped siblings (glyph in-flight 10 s, sprite
atlas 10 s, raster ledger ~10.5 s); per-kind override is a constant in the registration
table, so every deadline is visible in one file.

### 4.3 Registry API and scopes

```ts
registry.hasPending(scope?: PendingWorkScope): boolean   // OR over the scope's kinds
registry.count(kind: PendingWorkKind): number            // for numeric projections
```

Scopes are named, frozen kind subsets declared next to the union:

- `SCOPE_ALL` — Q2 itself (site 1's data half; replaces site 3).
- `SCOPE_VT_PIPELINE` = `vt-fetch | vt-replaced | vt-upload | vt-missed` — **exactly**
  today's `hasPendingSourceWork()` set, so burst exit keeps its current behavior
  byte-for-byte (non-goal above).
- ~~`SCOPE_TILE_COUNT` → `getMissingTileCount()`~~ — **DROPPED 2026-08-31** (#2162/#2163):
  the owner corrected the accessor's contract to "NOT a convergence signal" (it carries
  three of `keepLoopWarm`'s six terms by design), and whether to fix the NUMBER instead is
  #2162's option (B), an open owner decision. This design no longer touches
  `_missingTileCount` / `getMissingTileCount()`; if (B) is chosen later, the registry's
  per-kind counts are the natural implementation, but that lands under #2162, not here.

### 4.4 Call-site collapse map

| site today                                                                        | after                                                                                                                                         |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `shouldRenderThisFrame` data terms (glyph, sprite, `hasPendingSourceWork()` call) | one term: `registry.hasPending(SCOPE_ALL)`; animation terms stay as-is                                                                        |
| `hasPendingSourceWork()` (map.ts:4512)                                            | its hand-maintained signal list becomes `registry.hasPending(SCOPE_VT_PIPELINE)`; the composed call chain (#2158) is unchanged                |
| `keepLoopWarm()` + its `KeepWarmInputs` plumbing                                  | its six-signal list becomes registry reads at the same end-of-frame site; the composition (`→ _needsRender →` first term, #2158) is unchanged |
| `_missingTileCount` manual sum                                                    | OUT OF SCOPE — #2162 option (B), an owner decision (see §4.3)                                                                                 |
| `awaitMapIdle`                                                                    | unchanged (consumes `idle`)                                                                                                                   |

Per-frame counts (`vt-missed`) are _written into_ their source by the frame that computes
them (as `totalMissed` already is) — the registry reads, never computes.

### 4.5 Enforcement — three layers, honest about coverage

- **L1 (compile)**: registration is a `Record<PendingWorkKind, PendingWorkRegistration>`
  built in `map.ts`. A union member without a registration — or a registration for a
  removed member — is a TS error. This is the "compile error" the roadmap asks for, and
  its honest extent: it catches **union↔table drift**, not a class that never joined the
  union.
- **L2 (generated contract suite)**: ONE test factory iterates `PENDING_WORK_KINDS` — the
  same runtime constant, no second hand-synced list (§12 second-ratchet) — and demands a
  per-kind fixture proving the five arms #2129 codified: in-flight → warm; landed → cold;
  **failed → cold**; **deadline → cold with no re-arm**; and a **success** arm (the
  mutant-killer: every arm ending in `failed` lets `status !== 'failed'` survive — real in
  #2122). Fixtures are keyed `Record<PendingWorkKind, Fixture>`, so a missing fixture is
  also L1-loud. This is where probe-flavor boundedness is actually enforced.
- **L3 (fetch-entry ratchet)** — **LANDED ON MAIN 2026-08-31 as Gate 10** (#2160/#2161,
  `map/src/architecture-invariants.test.ts`), in a stronger shape than proposed here:
  per-file `safeFetch` SITE COUNTS are pinned (a new fetch in an already-registered file
  still trips it), the #996 key-resolution companion is carried, and the classification
  admits TWO valid mechanisms — (a) a deadline-bounded keep-warm term, or (b)
  `invalidate()` on arrival. This design's registry is the single implementation point
  for mechanism (a); Gate 10 is the census that every fetcher has (a) or (b). The
  increment that would have built L3 here is therefore dropped.
- **What nothing catches** (named, not hidden): an async subsystem that neither fetches
  through the shared entry points nor registers — e.g. a future worker round-trip with its
  own transport. The mitigation is L3's review-time visibility plus this doc; no type
  system sees that class.

## 5. Migration plan — one verified PR per increment

Each increment: `bun run build` (typecheck authority) + affected vitest; increments that
can move idle timing (2, 3, 6) additionally run the §5 ladder on
`_bundle-replay-parity-gate` + `_rtc-recombine-parity-gate` (the #2120 pair — the most
idle-sensitive gates in the tree) and must be hash-stable step-for-step.

1. **Core**: `pending-work.ts` (union, registry, scopes, deadline table) + L2 factory +
   the `glyph` kind migrated as the first registrant (probe flavor; its five-arm tests
   from #2120 re-point at the fixture). `shouldRenderThisFrame` keeps its other terms;
   the glyph term is replaced by the registry read. Cut test: deleting the registration
   reds L1; deleting the map.ts wiring reds the wiring test only.
2. **#2129 lands on the new rails** — **LANDED** (§9.4 settled (a)): `coverage` is the
   first ledger-flavor registrant. The registry owns the stamps and the 10 s deadline
   (`COVERAGE_INFLIGHT_KEEP_WARM_MS`); the ticket spans exactly the `state.inFlight`
   window in `readCatalogueItem`; mechanism (b) stays for post-deadline arrivals.
   Cut-verified three ways: the map.ts injection, the cell-read checkout, and the
   central deadline each red only their own test.
3. **`sprite`** migrated — **LANDED** (probe flavor; the 11-line map.ts term/comment
   moved onto its registration, the existing #2126 WIRED test now pins the registry
   route, and the probe-severing cut reds exactly the sprite half while glyph stays
   green).
4. **Raster/DEM family** (`raster-fetch/retry`, `dem-fetch/retry`) — probe adapters over
   the existing ledgers; `render-loop-keep-warm.ts` still exists, now reading the registry
   for these kinds (transitional).
5. **VT family** (`vt-fetch/replaced/upload/missed/lod`) — adapters registered in
   `map.ts` over the probes VTR/TileCatalog already export; `vector-tile-renderer.ts` and
   `tile-selection-cache.ts` are **not edited** (shrink-only ceilings).
6. **Simplify the composed helpers** (rescoped 2026-08-31 per #2158 — this was
   "Collapse"): `keepLoopWarm` and `hasPendingSourceWork` keep their places in the
   composed chain but their hand-maintained signal lists become registry scope reads;
   burst deps re-wired to `SCOPE_VT_PIPELINE` (same signal set); `_missingTileCount`
   untouched (#2162 option (B) is the owner's); `map-event-bus` untouched.
7. ~~**L3 ratchet**~~ — **DONE ON MAIN** as Gate 10 (#2161,
   `architecture-invariants.test.ts`); see §4.5 L3. Nothing to build here.

Rollback story: every increment before 6 is additive (old predicate + registry agree via
a transitional dual-read assertion in dev builds); increment 6 is the only list-rewiring
step and lands alone.

## 6. Verification (what closes #2149)

- L1/L2 in place (L3 = Gate 10, already on main); the five-arm suite green for every
  registered kind.
- Cut tests: unregistering a kind reds only L1; dropping a deadline reds only that kind's
  deadline arm; severing the map.ts wiring reds only the wiring test (assert the CAUSE
  before the EFFECT — §12).
- `readiness-gate-unreachable-target.test.ts` (#2103), sprite/glyph keep-warm suites,
  Gate 10, and the #2120 parity pair stay green throughout.
- After increment 6, `shouldRenderThisFrame`'s data terms and `keepLoopWarm`'s body read
  the registry; no hand-maintained per-class `if` list remains outside it.

## 7. Socratic self-critique (architect pass)

**Q1 — Why not one function replacing all five sites?** Because the sites ask different
questions (§3): render-continuation vs data-convergence vs a numeric projection vs a
scoped burst signal. Collapsing _call sites_ would force animation ledgers and counts into
one predicate and break burst semantics. The single authority is the **truth source**
(the registry); the sites become projections. Weak version rejected.

**Q2 — Is the registry a god object?** It holds ledgers and closures, no class logic; no
resource class imports another; `pending-work.ts` imports nothing from `map/` (types
only). Registration happens in `map.ts`, which already constructs every party. Dependency
direction: strictly inward to a leaf module. No new edge the arch-ratchets forbid.

**Q3 — Probe flavor re-admits drift: an adapter can lie about boundedness.** Conceded at
the type level — and answered at L2: a kind without a passing deadline arm does not merge.
The alternative (central tickets for ALL kinds) was rejected: it would require edits
inside `vector-tile-renderer.ts` (5454, shrink-only) and `tile-selection-cache.ts` (1066,
shrink-only) and would double-book ledgers that already exist and are already bounded
(`failedTiles`, glyph ranges). Flavor choice is ergonomics; L2 is the enforcement for
both.

**Q4 — Does routing through the registry move idle timing?** Each migration replaces a
term with a probe reading the SAME underlying state behind the SAME deadline — the dev
dual-read (§5 rollback) asserts old/new agreement per frame during transition, and the
#2120 parity pair pins the observable: hash-stable steps. The one place semantics could
shift by accident — burst exit — is scope-pinned to today's exact set.

**Q5 — Why `map/src`, not `engine/`?** The kinds are content (tiles, glyphs, coverage);
engine is content-blind by ratchet (`engine/src/dependency-direction-ratchet.test.ts`).
The engine loop already receives the outcome through `host._needsRender`; a generic
engine registry would add a contract with exactly one consumer and push a content
enumeration toward the generic layer. Rejected.

**Q6 — Allocation and cost?** `hasPending` is a for-loop over a frozen 12-entry array of
O(1) probes; ledger expiry prunes on observation (amortized, normally-empty sets); no
iterators over Maps, no per-frame closures. Same order of work the five sites do today,
done once.

**Q7 — Why now, before the god-file extractions (Phase 5, bullet 3)?** Because the
adapter flavor makes the registry independent of those extractions — nothing here edits
the capped files — and because #2129 is open NOW and should land on the new rails rather
than as a fourth hand-added term.

**Q8 — Is the L3 ratchet the second-ratchet mistake?** It would be if L2 also kept a
list. It does not: L2 iterates the runtime union; L3 is the only allowlist, it guards a
different invariant (entry-point coverage, not kind behavior), and it carries the
key-resolution companion assertion that keeps it from going vacuously green.

## 8. Rejected alternatives (do not re-propose)

Carried from the roadmap (`2026-08-25-marathon-roadmap.md:196-206`): hash-polling as the
settle signal; reverting #2103; widening timeouts "to give content time". Carried from
#2126: reusing an existing terminal/prepare predicate as the keep-warm probe (unbounded
against a host that never answers). New here:

- **Type-only enforcement without L2** — a type cannot see a deadline; boundedness is the
  load-bearing half (#2091).
- **Central tickets for every kind** — double-books existing bounded ledgers and edits
  ceiling-locked files (§7 Q3).
- **Event-driven pending/settled notifications** — cross-class event plumbing and
  ordering hazards to optimize twelve O(1) probes per frame that need no optimizing.
- **Placing the registry in `engine/`** — §7 Q5.

## 9. Open for owner decision

1. Deadline default 10 s + per-kind overrides in one table — **settled** (approval,
   2026-08-31).
2. ~~Increment 2 ordering~~ — superseded by §9.4 below.
3. Burst-exit scope stays `SCOPE_VT_PIPELINE` until #2150's instrument measures the
   widened alternative — **settled** (approval, 2026-08-31).
4. **coverage — mechanism (a) or (b)?** — **settled (a)** (owner, second "허가",
   2026-08-31). Landed as increment 2: the ledger-flavor ticket spans exactly the
   `state.inFlight` window in `readCatalogueItem`, the deadline is enforced centrally in
   `pending-work.ts`, Gate 10's map.ts row now reads (b)+(a), and mechanism (b)'s
   `invalidate()`-on-arrival stays for post-deadline landings.
