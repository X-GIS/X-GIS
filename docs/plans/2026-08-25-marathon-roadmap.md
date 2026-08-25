# Marathon roadmap — rendering performance campaign (2026-08-25)

Standing authorization: the owner asked for fundamental architecture / memory / algorithm
work, not point fixes ("근본적으로 아키텍쳐 개선이나 메모리, 알고리즘 개선으로 가능한거라면
그것도 진행"). This document is the durable record of the whole remaining queue so any
session can resume it cold (CLAUDE.md §9.5). Each phase states: why it is where it is, what
closes it, and what was already ruled out.

Landed so far (do not re-derive):

- issue #2042 — INC-1, INC-2, INC-3, INC-4a-d, INC-5, INC-5b, and the POLYGON half of INC-6
- issue #2091 — the readiness-gate unreachable target
- shipped as PRs #2083, #2090, #2098, #2103

## Facts verified against the tree on 2026-08-25 (do not re-derive)

- **`__XGIS_SPLIT_BIND` is still opt-in.** `map/src/render/pipeline-factory.ts:973` reads
  `=== true`, so nothing in the split-bind campaign has shipped to a user yet. Every "add a
  kill switch / deprecate the legacy path" idea is strictly downstream of the default flip.
- **`LINE_SEGMENT_STRIDE_F32` is still 20** (`data/src/line-segment-build.ts:49`). #2089's
  20→32 widening has NOT landed; any item justified by "the segment ceiling just dropped"
  must be re-justified.
- **`main`'s own push runs prove nothing about the render leg.** On a changelog-only commit
  the paths filter skips `render-shard` entirely and `render-gate` runs `r='skipped'` and
  reports success (verified on run 32849832346 @ `9be7ae4`). The red this roadmap's Phase 0
  addresses appears on PULL-REQUEST runs, which is also where it must be confirmed fixed.
  This is CLAUDE.md §13's "a green check does not mean YOUR gate ran", in the concrete.
- **`_bundle-replay-parity-gate` has a within-arm oracle nobody was using.** `SCRIPT[1]` and
  `SCRIPT[4]` are the identical camera (`spec:52`, `:56`) and were only logged. Cross-arm
  equality cannot see a settle that fires early — both arms sample at the same wrong point
  and agree. Within-arm can, and in the observed red run the OFF arm already disagreed with
  itself. Now asserted.

---

## Phase 0 — the idle contract (BLOCKING: every PR that merges main is red)

Every PR that merges `main` inherits a red `render-gate` on
`_bundle-replay-parity-gate`. Traced, reproduced locally:
steps 0/1 DIFF between arms, steps 2/3/4 EQUAL, and step 4 (a revisit of step 1's pose)
hashes equal to the ON arm's step 1 on BOTH arms. That is a sampling-time failure, not a
render difference — the first-visit frames are sampled before their content has landed.

Root cause, at `map/src/map.ts:4440-4460` (`shouldRenderThisFrame`) and
`map/src/render-loop-keep-warm.ts:70-82` (`keepLoopWarm`): **neither authority knows about
glyph ranges in flight.** `GlyphPbfCache` (`map/src/text/sdf/pbf/glyph-pbf-cache.ts:139`)
marks a range `{status:'loading'}` and resolves it asynchronously; nothing between that and
the idle event observes it. So `idle` has never meant "converged" — it meant "converged
except for text".

Why it only surfaced now: before #2103, a source whose `maxLevel` sat below `floor(z)` (the
synthetic earth surface is `maxLevel 0`, and ships with every globe/background fill) pinned
`_czPendingAdvance` for the full `READINESS_TIMEOUT_MS` (5 s), cleared it for exactly one
frame, and re-armed. That oscillation gave every `idle` a 0-5 s delay, which was long enough
for glyph ranges to land. #2103 made the target reachable — correctly — and the delay went
away with it. #2103 exposed this bug; it did not create it.

**Fix:** a bounded glyph-in-flight predicate.
`GlyphProvider.hasPendingLoads?()` (optional, chain-of-responsibility like the existing
`isResolved?()`), implemented on `GlyphPbfCache`, ORed by `PbfRasterizer`, surfaced through
`TextStage`, and read in `shouldRenderThisFrame` next to the existing
`textStage.getFadeLedger().hasActive()` keep-alive — the same authority that already gates
both rendering and `idle`, so no second opinion is created.

**Bounded BY CONSTRUCTION, non-negotiable.** `safeFetch` (`shared/src/safety.ts:209`) has no
timeout, so a hung glyph fetch would leave a range `'loading'` forever. An unbounded
keep-warm predicate is exactly the never-idle wedge #2091 was: each `'loading'` range
carries a `since` stamp and stops counting past a deadline, mirroring the readiness gate's
5 s safety net and the raster ledger's `MAX_TILE_ATTEMPTS`.

**Closes when:** `_bundle-replay-parity-gate.spec.ts` green with all 5 steps EQUAL, AND
`map/src/render/readiness-gate-unreachable-target.test.ts` still green (the fix must not
re-break what #2103 fixed), AND a direct unit assertion that a `'loading'` range holds the
loop warm and a stalled one stops holding it.

Folded in: **#2101** (`awaitMapIdle`'s stale fast path) — same family. A helper that answers
"already idle" from a stale flag has the same defect one layer up.

## Phase 1 — finish #2042 (uniform block split)

1. **INC-6 LINE half.** `map/src/shaders/dsl/line.ts:340` still reads `cam_h/cam_l`, so
   LINE flat-arm draws restage per (tile x camera). Layout space is already reserved at
   `line.ts:208` (`_pad_tile_origin_merc_hl`), so no layout migration. Recon in
   `scratchpad/inc6-recon.md`; flat-arm CPU writes at VTR:1316-1317 and :1642-1643.
   After this, the flat arm's TileBlock lanes are fully static and the walk-skip's
   Mercator coverage matches globe.
2. **INC-7 — flip `__XGIS_SPLIT_BIND` ON by default.** Full §5 sweep on both backends
   before the flip; the flag stays as an escape hatch for one release.
3. **INC-8 — delete the legacy path.** Only after ON has shipped green. The legacy CPU
   uniform writes are dead weight on every frame until then.

## Phase 2 — re-measure the performance truth (#1190)

Every encode-wall number taken before Phase 0 was measured on a map that could not idle.
That is a contaminated instrument (CLAUDE.md §12: "a metric gradient whose x-axis is the
order I happened to run things is noise"). Re-measure, on a scene that now genuinely
settles:

- the `frame.encode` sweep baseline,
- the two original user reports: `osm_style` z17 pitch75 zoom-out pressure, and `ofm`
  (openfreemap_bright) janky tile loads on zoom in/out,
- the #2042 slope: encode ms vs shows, ON vs OFF, after INC-6/7.

Only then decide whether #1190 needs another lever at all.

## Phase 3 — correctness backlog

- **#2108** — adapter failure backoff (the one open finding from the #2103 adversarial
  review).
- **Readiness contracts as tests.** Phase 0 adds glyphs; sprites (`sprite-atlas-host.ts`
  also calls `safeFetch`) are the same shape and have never been checked. One test per
  async resource class asserting `idle` implies drained.
- **FLICKER / fallback correctness** — `missedTiles` counts cells with _no_ fallback, so a
  cell drawn from a magnified ancestor is invisible to every convergence signal. That is
  fine for keep-warm (the fetch signal covers it) but it means `getMissingTileCount()`
  under-reports; confirm or fix.

## Phase 4 — gate & CI health

- **Vacuity audit.** CLAUDE.md §12 records two gates that passed identically whether the
  mechanism under test worked or not. Sweep the render gates: for each, cut the specific
  mechanism and confirm the failure message names the severed half.
- **`stepAndSettle`'s listener race.** `_bundle-replay-parity-gate.spec.ts:155` registers an
  `idle` listener and then moves the camera in the same evaluate. If the move does not
  actually dirty the frame, the event has already passed and the wait hangs for the full
  220 s budget. Same class as #2101. Make the wait edge-safe (arm a flag on the pre-move
  frame, or race against a settled-state poll).
- **flaky-report follow-through** — `render-shard` prints `flaky-report: N flaky`; nothing
  reads it yet. A recurrence should be actionable, not archaeology.
- **#2114 — `_globe-dateline-wired-gate` converges on a different quantity than it asserts.**
  The poll's `tileKey` maps over EVERY tile in `sources.world.tiles` with no `z` filter,
  while `findBothAntimeridianSides` skips `z < 1` before incrementing `considered`. A tile
  set of exactly `[{z:0,x:0,y:0}]` is therefore a stable non-empty key — the poll declares
  convergence, `considered === 0`, and the spec throws its "the page did not get as far as
  requesting one" message at a page that was merely early. The predicate mismatch is
  confirmed by construction; whether it is the live cause of #2114's red is the open half,
  and the tell is `selectMs`: ~4 s means premature convergence, the full 120 000 ms means a
  real stall. Lift the poll's predicate into a pure function and unit-test it (`[{z:0,…}]` →
  not converged) before touching a browser.

## Phase 5 — 5-year architecture debt

- **One authority for "is the scene converged?"** #2091, #2101, #2116 are three faces of the
  same defect: convergence is decided in `shouldRenderThisFrame`, in `keepLoopWarm`, in
  `hasPendingSourceWork`, and again in `awaitMapIdle` — four places, drifting. Collapse to
  one predicate with one list of resource classes, and make adding a new async resource
  class a compile error if it does not register.
- **Every keep-warm signal bounded by construction.** Phase 0 establishes the rule; apply it
  to the existing signals and pin it with a test, so the next `safeFetch`-without-timeout
  cannot wedge the loop.
- **Shrink-only god files.** `vector-tile-renderer.ts` (5454) and `tile-selection-cache.ts`
  (1066) are both at their ceilings, which is now actively distorting design — see the
  comment in `render-loop-keep-warm.ts:20-31` explaining that a forwarder could not be added
  because both owning files are capped. Plan real extractions, not more ceiling bumps.

---

## Rejected approaches (do not re-propose)

- **Hash-polling as the settle signal** in the parity gate ("N identical hashes"). Tried and
  rejected: the refinement pipeline lands content for tens of SwiftShader-seconds, so it
  repeatedly certified half-refined frames — 4 distinct stable states for one camera,
  measured. The fix is to make `idle` honest (Phase 0), not to stop using it.
- **Reverting #2103.** It fixed a real never-idle wedge and its regression test
  (`readiness-gate-unreachable-target.test.ts`) pins the behaviour delta. Reverting trades a
  sampling bug for a permanent-re-render bug.
- **Widening the readiness gate's timeout to "give content time".** That is the accidental
  mechanism that hid this bug for months; it is a sleep, not a predicate.
