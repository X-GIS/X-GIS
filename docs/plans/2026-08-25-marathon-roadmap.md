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
- **A RENDER INPUT can be a function of wall-clock, and one is.** The adaptive quality
  controller samples measured rendered-frame intervals (`engine/src/gpu/adaptive-quality.ts:198-212`)
  and is live in any scene that sets no `?scenescale`. Measured on the parity gate's own
  scene under SwiftShader: notch `0 → 3 → 4` within two script steps, `medianFrameMs`
  149 → 6032, and `adaptiveFarLodBoost` `1 → 4`. The boost multiplies the tile selector's
  far-field error ceiling (`map/src/render/tile-selection-cache.ts:303`,
  `map/src/render/vector-tile-renderer.ts:4393`), so **the selector requests a different
  tile set on a slower machine**. On a hash-equality rung there is no tolerance to absorb
  that. Pin with `?adaptive=0` (`engine/src/gpu/quality.ts:24`, applied at module load
  `:281`). **`?scenescale=` is NOT a substitute** — it pins only the dpr half at
  `render-loop.ts:141` and leaves the far-LOD boost live, so a gate pinned that way stays
  timing-dependent through tile selection.
- **`idle` never covered in-flight glyph ranges** — but the style-import path drops the
  style's `glyphs` (#2121), so no style-import fixture can exercise that path at all.
  Measured: `map.glyphsUrl === null` and `textStage.pbfRasterizer === null` in
  `import_maplibre_mirror`, whose `style.json` does set `glyphs`. Any reasoning about the
  glyph pipeline that uses a style-import demo as its witness is reasoning about a chain
  that is not there.
- **`_bundle-replay-parity-gate` has a within-arm oracle nobody was using.** `SCRIPT[1]` and
  `SCRIPT[4]` are the identical camera (`spec:52`, `:56`) and were only logged. Cross-arm
  equality cannot see a settle that fires early — both arms sample at the same wrong point
  and agree. Within-arm can, and in the observed red run the OFF arm already disagreed with
  itself. Now asserted.

---

## Phase 0 — the idle contract — **LANDED** (PR #2120, squashed as `6864afd`)

> Outcome: the glyph predicate shipped, and the investigation turned up THREE render gates
> that were not measuring what they assert. `_bundle-replay-parity-gate` and
> `_rtc-recombine-parity-gate` now produce IDENTICAL hashes step for step across four flag
> states — one canonical frame per camera pose. Attribution on the RTC gate, one cut at a
> time: 7448 px → 3497 (demo chrome removed) → 0 (adaptive ladder pinned). With the gates
> green the vacuity witnesses finally executed, so #2042 INC-1 and INC-6 are now positively
> verified rather than merely un-accused. Filed and NOT fixed here: #2121, #2122.

The original analysis is kept below because its reasoning — including where it was wrong —
is the record.

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

Why it only surfaced now — and note the TWO REGIMES, which an earlier draft of this document
conflated. What #2103 removed was a **sleep**, and the sleep is regime-dependent:

| `floor(z) − source.maxLevel` | behaviour before #2103                                                                               | which bug                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `= 1`                        | `step === target`, so the timeout clears the flag → a **hard ≈5 s floor on every settle**, then idle | the parity gate's accidental sleep |
| `≥ 2`                        | `step < target`, so `cz === target` never holds and the flag is never nulled → **never idle**        | #2091's permanent busy loop        |

The gate's scene is the first regime (zoom 1.5, `__synthetic_earth_surface__` is `maxLevel 0`
and ships with every globe/background fill). The floor is **hard**, not a 0-5 s draw: the flag
is nulled at each settle (`tile-selection-cache.ts:553`), so the next settle re-arms with a
fresh `since` (`:462-464`) and must wait the full `READINESS_TIMEOUT_MS`. That deterministic
5 s is why the gate was RELIABLY green while carrying two latent defects. #2103 made the
target reachable — correctly — and the sleep went with it. #2103 exposed this bug; it did not
create it, and reverting it restores the sleep, not the guarantee.

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

- **One authority for "is the scene converged?"** ⚠ **The "four places, drifting" framing
  below was wrong — corrected 2026-08-31 by reading the four sites.** They are composed, not
  competing, and the composition is explicit:
  `keepLoopWarm` → `_needsRender` (`render-loop.ts:682`, an assignment at end-of-frame) →
  `shouldRenderThisFrame`'s FIRST term (`map.ts:4424`); `hasPendingSourceWork` is a private
  helper `shouldRenderThisFrame` calls at `map.ts:4479`; and `awaitMapIdle`
  (`playground/e2e/helpers/visual.ts:626`) does not decide anything — it reads the event
  bus's `_wasIdle`, which is driven by `shouldRenderThisFrame`, and it is already edge-safe
  (checks the current state before subscribing). So there is ONE composed authority. Do not
  open this as a "collapse four predicates" refactor; that premise does not survive contact
  with the code.

  What survives, and is still worth doing: **nothing enumerates the async resource classes.**
  `shouldRenderThisFrame` is a hand-maintained list of 13 `if` terms, and adding a resource
  class means remembering to add one — #2116 (glyphs) and #2122 (sprites) were each a
  human noticing an omission, not a compiler catching one. Make the class list the single
  registered thing, so a new async resource that does not register is a compile error. That
  is the real content of this item.

  Also noted while reading: `render-loop.ts:680` sets `_needsRender = false` and `:682`
  immediately overwrites it with `keepLoopWarm(...)`, so `:680` is dead. The assignment at
  `:682` is `=` rather than `|=`, so an `invalidate()` issued from inside the frame would be
  clobbered — **checked 2026-08-31, and no such caller exists**, so this is latent, not a
  bug. Every `invalidate()` in `map/src` is either a host-driven public API call
  (`setPaintProperty`, layer mutations, `setView`, gesture end) or an ASYNC callback:
  `background-pattern-atlas.ts:40` fires from `onLanded`, the coverage sites from fetch
  completions, and all six `GraphicsManager` `repaintHook?.()` calls
  (`graphics-manager.ts:249,265,514,533,560,572`) sit in host-facing mutation APIs — add,
  `append`, tint/feat update, remove. None runs inside `render()`. Do not "fix" `:682`
  speculatively; making it robust needs `= false` moved to the START of the frame plus
  `||=` here, which is a real behavioural change and should wait for an actual in-frame
  caller to exist.

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
