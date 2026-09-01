# Uniform block split: Frame / Show / Tile — killing the per-tile restage walk

**Status:** design (architect pass) · **Driver:** #1190's post-bundle residual · **Author discipline:** author-architect-refactor (design + self-critique BEFORE code)

## Problem, measured

With render bundles default-ON (#2038), the encode wall's command-emission half is gone
(`_perf-encode-scaling-sweep`, SwiftShader: 129 layers 49.4 → 32.1 ms/frame, slope
0.37 → 0.19 ms/layer). The residual 0.19 ms/layer is the bundle HIT path's re-walk of
`renderTileKeys`: every navigating frame it revisits every (show × tile) pair to restage
the ~30-field per-tile uniform block into the per-frame `UniformRing` and rebuild the
strokeQueue — output that the replayed bundle then reads only through the ring bytes.
The walk exists because slot CONTENT is per-frame; slot ADDRESSES are per-frame too
(ring cursor), which is also why `BundleKeyState.ringCursor` had to exist at all, and
why Lever 4 (cross-tile draw merging) is blocked ("per-tile dynamic-offset slots").

## Field audit (`polygonU`, map/src/shaders/dsl/polygon.ts)

| class                                                        | fields                                                                                                                                                                                                                                       | writes/frame after split                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **FRAME** (camera/style; one value for the whole VTR frame)  | `mvp`, `proj_params`, `log_depth_fc`, `zoom`, `globe_eye`, `light_dir_ecef` (camera-anchor rotated), `cam_ecef_center_h/l` (INC-1), `input_f32_0..7`, `input_color_0..3` (style-global — INC-3 correction)                                   | 1                                                       |
| **SHOW** (paint; per show, re-resolved on zoom/time interp)  | `fill_color`, `stroke_color`, `opacity`, `layer_depth_offset`, `extrude_height_m`, `extrude_base_m`, `fill_translate_x/y`, `pattern_active`, `light_color_packed`, `pick_id` (+ relocated `fill_antialias` / `fill_vertical_gradient` flags) | N_shows (~80 on Bright)                                 |
| **TILE** (static per (slice, tile, worldCopy[, clipTarget])) | `tile_origin_merc`, `tile_extent_m`, `tile_dequant_scale`, `tile_dequant_half`, `clip_bounds`                                                                                                                                                | 0 (written at upload / first draw; freed with the tile) |
| **TILE × FRAME — the crux**                                  | `cam_ecef_off_h`, `cam_ecef_off_l` (= tileEcefCenter − cameraCenter, DSFUN hi/lo); `cam_h`, `cam_l` (Mercator rel — the flat-arm analogue, INC-6; the audit originally mis-filed these as FRAME)                                             | 0 — recombined in-shader, see below                     |

Today all four classes share ONE 256-byte block written per (show × tile × copy) per
frame. After the split, per-frame CPU writes drop from `O(shows × tiles)` blocks to
`1 + N_shows`, and the per-tile dynamic offset becomes a STABLE address.

## The crux: RTC re-centering without a per-frame per-tile write

`cam_ecef_off = tileEcefCenter − cameraCenter` is per-(tile × camera) by construction —
it is the DSFUN precision core (#the ECEF analogue of line.ts `cam_h/cam_l`). The split
moves the subtraction INTO the vertex shader:

- TILE block carries `tile_ecef_center_h/l` (static, split once at upload from f64),
- FRAME block carries `cam_ecef_center_h/l` (written once per frame),
- the VS computes `off = df64_sub(tile_ecef_center, cam_ecef_center)` per vertex (or
  once per invocation group) using the existing shader-dsl fp64 module, then proceeds
  exactly as today (`ecef_rtc + off`).

**Error budget (closed-form, render-error-budget discipline):** |off| ≤ 2·EARTH_R ≈
1.3e7 m. df64 subtraction of two hi/lo pairs carries relative error ≤ 2⁻⁴⁸ ⇒ absolute
≤ 1.3e7 × 2⁻⁴⁸ ≈ 5e-8 m (50 nm), five orders below the mm-scale bar the pipeline
already budgets at z22 (see the fp64 field guide + the #915 renorm ledger). The
subtraction is also Sterbenz-benign in the hot case (tile near camera ⇒ catastrophic
cancellation of the HI parts is exactly what two_diff handles losslessly). Cost: one
df64 sub (~6 f32 ops) per vertex — noise against the existing DSFUN dequant chain.

## Target end state

- Draws bind THREE uniform ranges: frame UBO (plain binding), show UBO (dynamic offset
  `showIdx × slotSize` — stable, no ring), tile UBO (persistent slot from a free-list
  arena keyed `(slice, tileKey, worldCopy[, clipTarget])`, freed on tile eviction).
- Bundle keys lose `ringCursor` (addresses are stable by construction — the invariant
  that #2038 enforced dynamically becomes structural); the hit path stops walking tiles
  entirely: selection (cached) → key check → `executeBundles`.
- Lever 4 unblocks: same-buffer stable tile slots make cross-tile draw concatenation a
  data-layout question instead of an addressing impossibility.

## Increments (each lands green through the full gate + §5 parity/pixel rungs)

1. **INC-1 — shader-side recombination behind a variant flag.** Add
   `tile_ecef_center_h/l` + `cam_ecef_center_h/l` fields; emit a variant computing
   `off` in-VS; CPU still writes the legacy fields too. Gate: a compute-pass parity
   test (shader-math-parity pattern) comparing in-VS `off` against the CPU value over
   a seeded camera/tile sweep, bound asserted against the 5e-8 m budget; §5 pixel
   parity old-vs-new variant (hash rung at settled cameras).
2. **INC-2 — TileBlock persistent arena.** Free-list allocator keyed
   `(slice, tileKey, copy, clipTarget)`; write at upload; free on evict (hook beside
   the existing arena-compaction bundle-invalidate seam). Gate: allocator unit suite +
   leak assert (alloc count == live tiles) + full render gates.
   _Implementation notes (as landed):_
   - **clipTarget resolved by EXCLUSION, not by key.** A fallback-clip draw's
     `clip_bounds` depends on WHICH visible descendant clips it (`visibleKey`) — an
     unbounded draw-time key space, not a binary lane. Clipped draws therefore keep
     the per-frame ring slot permanently; the arena covers UNCLIPPED draws only and
     its `clip_bounds` lane is always the −1e30 sentinel. (The original
     "(fallback, visible)-PAIR static" self-critique underestimated the fan-out: one
     parent can clip to N descendants in one frame.)
   - **Free seam = the existing `${tileKey}:${sourceLayer}` release hook** VTR already
     injects into every GpuTileStore evict/drop/supersede path — zero store changes.
     `resetForReupload` (which bypasses the hook) pairs with a wholesale `resetAll()`.
   - **Write at first unclipped draw**, not upload: worldCopy is a draw-time fact.
     Lanes cover copies −2..+2; an exotic copy returns −1 and stays on the ring.
   - **WebGPU main path only** for now; the WebGL2 twin's write-volume win is
     re-decided at INC-4 (no retained-command consumer there).
   - `tileBlockU` (map/src/shaders/dsl/tile-block.ts, group 0 binding 7 reserved) is
     the single layout authority; `tile-uniform-arena.test.ts`'s parity suite pins its
     bytes equal to the same-named polygonU lanes, making INC-4 a pure rebind.
3. **INC-3 — ShowBlock + FrameBlock declarations + the partition gate.**
   _Redefined as landed:_ INC-3 ships the `showBlockU` / `frameBlockU` declarations
   (unbound, zero emission — the INC-2 discipline) plus
   `uniform-split-partition.test.ts`: every polygonU field maps to EXACTLY one of
   {frame, show, tile}, or carries a recorded retirement (`cam_ecef_off_h/l` —
   recombined in-VS; their spare .w flags relocate to ShowBlock.fill_antialias /
   .fill_vertical_gradient) or pending note (`cam_h/l` — see INC-6), and every
   partitioned field packs BYTE-IDENTICALLY in its destination block (u32 raw-word
   lanes included). The original "per-frame writes = shows only" outcome needs the
   bind to be observable, so the live show-write swap moves into INC-4 where its
   zoom-interp + §5 gates can actually bite. Audit-table corrections discovered
   here: `input_*` lanes are STYLE-global (frame-class, not show-class), and
   `cam_h/cam_l` are per-(tile × camera) — the audit's FRAME row was wrong for
   them (they need INC-6, the flat-arm recombination, before they can leave the
   ring).
4. **INC-4 — draw path rebind + key simplification.** Bind the three ranges; delete
   `ringCursor`/`lineLayerOffset*` from `BundleKeyState` (they become structural);
   keep the alloc-count invariant one release as a canary, then retire it. Gate:
   `_bundle-replay-parity-gate` (unchanged — it is layout-blind) + the fail-before
   probe re-run to show the invariant is now unreachable-by-construction.
   _Re-sliced after the descriptor-surface recon (verified facts on #2042):_
   - **INC-4a (landed) — split-mode emit by IR DERIVATION.** The polygon entry
     functions are top-level consts whose IR builds once at import (module-scope
     eagerness), so a mode variable cannot reach them; instead
     `polygon-split.ts` derives the split module FROM the assembled legacy module:
     rewrite `member(bindingRef('u'), f)` chains and compiler-spliced dotted
     `varref`s (`u.zoom`) by the partition (destination sets read from the three
     block declarations — no second authority), swap the struct + binding decls,
     and rewrite the RETIRED lanes to their derived equivalents (`cam_ecef_off_*`
     → anchors-difference with the relocated `.w` flag from ShowBlock; `cam_h/l`
     → Mercator recombination; `tile_origin_merc` → `_hl.xy`) so the legacy
     flag-selects survive with BOTH arms equivalent — correct under either flag,
     no fragile select-matching. Unmapped `u` reads THROW at build. Gates:
     structure suite (no `u.` survivor, three blocks at 11/10/7, legacy leak-free)
     - Tint compile of the split module in `_wgsl-compile-gate`. WGSL-only by
       scope; nothing binds it yet.
   - **INC-4b — split pipeline family behind `__XGIS_SPLIT_BIND`.** NEW layouts +
     pipelines (never edits to the shared `mr-*BindGroupLayout`s — those drag in
     every MapRenderer bind-group site), split bind groups in
     bind-group-registry/feature-data-binder with the tile-arena onGrow →
     rebuild + bundle-invalidate hook, Show/Frame write paths, `[tileOff,
showOff]` threading through `recordFillDraw` (ascending 7 < 10 < 11 keeps
     WebGPU's offset-order rule trivial), §5 legacy-vs-split A/B. Strokes keep
     ring staging transitionally (line shader legacy).

     IMPLEMENTED (PR pending): the write path is a **span-copy, not a re-pack**
     (`uniform-split-bind.ts`): at the first qualifying draw per frame the
     frame-class lanes are COPIED from the live legacy `frameBlock` bytes into
     a plain 512-B FrameBlock buffer, and per show into a persistent
     `show-uniform-arena` slot (slot per `pickId & 0xffff`, refreshed once per
     frameCount) — byte-parity by construction since the SAME packer wrote the
     source; the span tables derive from the block declarations' reflected
     offsets (relocated flag lanes read the retiring vec4s' `.w` bytes).
     Factory half: `SPLIT_FILL_LAYOUT_ENTRIES` (7 dyn / 10 dyn / 11 plain,
     drift-test-pinned; hasDynamicOffset is inexpressible through the RHI
     reflect adapter, so the layout is native) + split flat/ground twins built
     from `emitPolygonSplitWgsl` via the ordinary `buildFlatFillMaterials`,
     surfaced as `FillRhiState.split`. Draw half: `recordFillDraw` executes the
     split twin when the caller resolved arena residency AND the matched twin
     is the default flat/ground pair — per-style, pattern, extrude, and
     clip-fallback draws keep the legacy bind (first-slice scope). The
     `_skipFillDrawForBundle` replay still runs the sync block, so replayed
     bundles read refreshed split content (the same discipline that keeps ring
     slots fresh under replay). Witnesses: `__xgisVtrSplitDraws` counter +
     `__XGIS_SPLIT_BIND_SKEW` (inverts the staged ShowBlock fill colour) in
     `_split-bind-parity-gate.spec.ts` (4 arms: legacy / split / split+skew
     must move / legacy+skew must be inert).

     TWO REAL DEFECTS the gate caught before first green (both now unit-pinned):
     1. **Show-slot aliasing** — a data-driven paint lowered on the CPU
        (demotiles countries-fill `match()`) fans ONE style layer into
        per-filter-bucket sub-shows that share the layer's pickId but carry
        different fill colours; keyed on `pickId & 0xffff` alone, the first
        bucket's copy stamped the frame and every bucket drew its colour.
        Show identity is now (sliceLayer, pickId) — the slice key carries the
        filter hash (uniform-split-bind.test.ts pins the aliasing).
     2. **Rewrite-walker identity break** — the first `rewriteExprsInFunc`
        (mapStmt/mapExpr composition) cloned shared Expr objects per
        OCCURRENCE; the optimizer's auto-var pass correlates a mutable
        value's declaration/assignments/reads by OBJECT IDENTITY (its header
        says so), so one shared position var fissioned into `_av0.._av4`,
        every read collapsed to the zero initializer, and split vertices all
        landed at (0,0,0,0) — valid draws, EMPTY frames, no validation
        error, and the ShowBlock-skew witness read ZERO pixels (which is the
        witness doing its job: it refused to certify a dead read). The
        walker now guarantees identity by construction (unchanged subtrees
        return the ORIGINAL objects; a changed shared subtree maps to ONE
        new object via a per-function memo) — rename-varrefs.test.ts pins
        the contract, polygon-split-emit.test.ts pins the derived module's
        auto-var count equal to legacy's.

   - **INC-4c — line split, then the walk deletion + `ringCursor` retirement
     move to INC-5 as planned.**

     IMPLEMENTED (PR pending): `line-split.ts` derives the three-block stroke
     module from the legacy line module with the SHARED rewriter
     (`makeSplitRewriteRead('TileUniforms')`, exported by polygon-split.ts —
     the line block is polygon's byte-mirror, so the partition + retired-lane
     derivations apply verbatim; the measured read set needs NO aliases).
     LineDraper gains lazy split twins (opaque + pick) against the factory's
     split layout, `LineBatch.split` carries `[tileOff, showOff]`, and the
     VTR resolve HOISTED to tile-loop scope so the stroke queue records each
     tile's split offset (`_strokeQueueTileOff`); the deferred stroke pass
     re-derives the show offset (syncs are frame-stamped/idempotent) and
     binds the three-range group. Exclusions: translucent MAX strokes, bake,
     pattern strokes (the split layout has no sprite bindings), WebGL2. The
     skew witness now inverts stroke_color too, and the §5 gate asserts BOTH
     counters (`__xgisVtrSplitDraws`, `__xgisVtrSplitStrokeDraws`).
5. **INC-5 — delete the hit re-walk; measure.** Expect the sweep's slope to drop from
   ~0.19 toward the selection+key floor; record on #1190 and re-scope the issue.

   _Design (recorded 2026-08-25, pre-implementation):_
   - **Per-show qualification, decided once per renderTileKeys call:** the walk's
     per-tile pack + ring stage is skippable only when EVERY draw of the call is
     split-bound — split state present, base layout (constant fill), no pattern,
     no extrude, no overdraw, and (for the queued strokes) non-translucent solid.
     A qualifying show packs its SHOW lanes once BEFORE the tile loop, syncs
     show+frame once (frame anchors via ONE `computeTileCameraAnchor(0, 0, 0,
projCenterLon, projCenterLat)` — the cam halves are tile-independent), then
     per tile does ONLY: ensureSlot/offsetOf (arena hit path) → recordTileFill
     with splitBind → stroke queue with tileOff. Skipped per tile: the anchor
     trig, every frameBlock.set.*, allocUniformSlot, stageUniformSlot.
   - **Non-resident fallback stays per-tile:** an exotic copy (offsetOf −1)
     falls back to the full legacy pack+stage for THAT tile only.
   - **Bundle-key coherence is free:** the replay guard already validates ring
     ADVANCEMENT (`_ringCursorForBundleKey() − keyState.ringCursor`, VTR ~3931).
     A skipped walk advances the ring by 0 at record AND replay; a residency
     change between record and replay changes the advancement → the existing
     guard forces a re-encode. `ringCursor` leaves BundleKeyState only when a
     frame has NO legacy ring consumers — measure first, retire in a follow-up
     if the sweep shows mixed frames are rare (INC-5b).
   - **Measurement:** `_perf-encode-scaling-sweep` draws EXACTLY the covered
     class (N unfiltered constant-colour fill layers, no strokes) — run the
     sweep flag-OFF vs flag-ON on the same commit, record both slopes on #1190.

   _Implemented (2026-08-25) — one deviation from the design above:_ the show/
   frame lanes are seeded by the FIRST tile's full pack (`packedOnce`), not by a
   dedicated pre-loop pack with a `computeTileCameraAnchor(0,0,0,…)` — the first
   tile's pack already writes every show/frame lane the span-copy lifts (show
   lanes are per-show constants, frame lanes per-frame constants, so WHICH tile
   seeds them is immaterial), and reusing it avoids a second anchor-math path
   that could drift from the packer. Mechanics as landed:
   - `splitWalkSkip` per-call qualification (VTR, above the tile loop): split
     state live, real slice, `visibleKeysForClip === null` (primary path ⇒
     every `visibleKey < 0`), base layout, no fill/line pattern, no per-feature
     extrude, `!translucentLines`, no composer line variant, no overdraw. Under
     these, the mat table proves every fill resolves to `eff.flat`/`eff.ground`
     (per-style ⇒ feature layout, pattern/extrude ⇒ excluded) and every queued
     stroke is opaque/pick — i.e. EVERY draw of the call is split-bound and the
     ring slot has no reader for a skipped tile.
   - Per tile after the first: `offsetOf` (resident?) → `syncShow`/`syncFrame`
     (stamp-guarded no-ops after the first tile) → `bindGroup()` → skip the
     WHOLE pack + `allocUniformSlot` + `stageUniformSlot` (`if (!skipPack)`
     wraps the pack block; `slotOffset`/`currentTileBg` hoisted). Non-resident
     copies fall back to the full pack for that tile only, which also runs
     `ensureSlot` — so a tile's FIRST unclipped draw always packs and its slot
     exists before any skip can trigger.
   - Stroke queue entries on skipped tiles carry `slotOffset = 0`; harmless —
     the split stroke branch replaces group 0 entirely, and under the
     qualification every queued stroke takes it (`sTileOff ≥ 0` + the drain's
     `strokeSplitBg` resolve conditions are all implied by `splitWalkSkip`).
   - Bundle coherence as designed: growth → `_onSplitRebind` (bind-group retire
     - `bundleCache.invalidateAll()`); residency drift between record and
       replay changes ring ADVANCEMENT → the existing replay guard re-encodes.
   - Pinned: `tile-uniform-arena-wiring.test.ts` now pins BOTH `offsetOf`
     sites (walk-skip gated on `splitWalkSkip && packedOnce`; pack-path resolve
     on `visibleKey < 0` + slice) and every qualification term.
   - **Instrument lesson (2026-08-25): the sweep's fixed 6 s settle measured
     WARMUP, not navigation.** First flag-OFF vs flag-ON read 279 vs 910
     µs/layer — but per-N diagnostics showed the 8 s windows held 0-2 frames
     (SwiftShader first-frame 20-40 s at n=128), `walkSkips=0` (the INC-5
     mechanism never ran — warmup draws are clip-fallback, `visibleKey ≥ 0`),
     and n=128 logged 385 bundle misses vs 6 hits (arena-growth
     `invalidateAll` re-record storm). So BOTH slopes were record-path
     warmup cost and say nothing about the steady-state claim — the #1190
     0.19 ms/layer baseline was measured the same way and carries the same
     caveat. The sweep now gates on bundleMisses convergence (probe
     invalidates + rAF-tick-counted polls), zeroes the mechanism counters at
     window start, and scales the window with N, printing per-window
     hits/misses/skips so the regime is witnessed, not assumed. the
     bundle-hit ring-alloc invariant (`_bundleWalkAllocs`, #1190) compares the
     hit re-walk's alloc count against the record frame's — a proxy for "baked
     ring dynamic offsets still align". A walk-skip record frame packs fresh
     tiles (`1 + k` allocs) and the next hit's re-walk skips them (`1`), so
     arm B threw `[XGIS INVARIANT] bundle hit re-walk allocated 1 ring slots
where the encoded bundle recorded 2` and the render loop halted. The
     proxy is VACUOUS under `splitWalkSkip` — the bundle bakes zero per-tile
     ring readers (even the seed tile's ring stage is write-only) — so the
     invariant is now exempted exactly there (`_lastWalkRingFree`, published
     by every call; key equality ⇒ identical qualification inputs ⇒ the
     exemption is stable across record and hit). The fallback-path invariant
     site is untouched (clipped walks can never qualify). The §5 gate asserts
     `__xgisVtrWalkSkips > 0` on the split arm so "skip engaged" is witnessed,
     not assumed.

5d. **INC-4d — per-style fill split twins (added 2026-08-25 by INC-5's measurement).**
The split class as shipped covers only VARIANT-LESS shows (synthetic earth,
polar caps, CPU-lowered match buckets): `generateShaderVariant` returns a
variant for EVERY compiled show and constant paints inline as preamble
consts (`shader-gen.ts` FILL_COLOR const even for `#rrggbb`), so every
converted-style fill draws a per-style composed pipeline → `mat !==
   eff.flat/ground` → legacy bind. The sweep (the #1190 scenario) therefore
never engages INC-5 (`walkSkips=0` in every steady window). This increment
puts the osm/ofm constant-fill class inside the split (and walk-skip):

- **Derivation is already variant-ready:** `buildPolygonSplitModule(variant,
pick)` composes the variant THEN swaps struct/bindings and rewrites reads;
  spliced `u.<lane>` reads route via the partition (`u.opacity` → ShowBlock,
  show-block.ts:30) and unmapped reads throw at build (fail-loud). The line
  side already emits its draper's own variant (line-material.ts splitMat).
- **Eligibility (scope guard):** const-preamble variants only — no extra
  group(0) bindings beyond the three split ranges (no feat_data, no palette
  atlas/sampler, no compute bindings), `!needsFeatureBuffer`, empty
  `paletteScalarGradients`. Authoritative check at derivation time: count
  the derived module's group-0 bindings; >3 ⇒ ineligible (stay legacy).
- **LAZY twins (the F4 lesson):** per-style twins reuse the pipeline's
  already-emitted WGSL, but a split twin needs its OWN emit + O2 fixpoint —
  eager per-style split emits would re-create the ~13×-boot-waste F4
  removed. Build each style's split twin on FIRST split-qualified draw
  (mirroring LineDraper.splitMat), cached per (style pipeline, pick).
- **Runtime wiring:** `FillRhiState.split` gains a lazy per-style registry
  (builder injected by the factory — the Material seam stays decoupled);
  `recordFillDraw`'s split branch extends to `ps` hits with an eligible
  twin; `splitWalkSkip` replaces `lineVariant == null` with "the call's
  fill pipeline has (or can build) a split twin AND the show's variant is
  const-preamble-eligible" — the term that today only COINCIDENTALLY
  protects per-style shows from the skip becomes the exact predicate.
- **Gate:** a §5 parity gate booting the sweep's synthetic style (N=8
  per-style constant fills — exactly the newly-covered class) OFF vs ON:
  amplitude-class budget + executed-mechanism witnesses (per-style split
  fills > 0, walkSkips > 0) + the skew witness (show-lane inversion must
  move per-style fills too).

_Implemented (2026-08-25) — deviations from the sketch above:_

- **Eligibility is decided on the EMITTED interface, not the IR decl
  list.** The polygon module statically declares sprite_atlas/samp
  (group-0 bindings 5/6) and the line module its pattern pair — the emit
  PRUNES them when unused, which is how the INC-4b/4c default twins fit
  the three-range layout at all. Counting `module.bindings` would have
  rejected every style including the defaults; the check instead emits
  the twin's WGSL once and requires its `@group(0) @binding(n)` set
  ⊆ {7, 10, 11}, reusing the same emitted string for the Material build.
  A derivation that reads outside the partition throws in the rewriter →
  ineligible (cached null; the same legacy-fallback class as pattern).
- **The stroke side rides the draper:** `LineDraper.splitEligible()`
  caches the same emitted-interface verdict per variant draper, gates the
  draw()-side split branch (closing the INC-4c latent crash where an
  ineligible-variant stroke reaching the split branch would throw at
  splitMat build), and `LineRenderer.splitStrokeEligible(variant)`
  forwards it to the walk-skip qualification — so the qualification's
  stroke clause is `!drawStrokes || lineVariant == null ||
splitStrokeEligible(lineVariant)`, and 'all'-phase per-style shows
  (the osm/ofm common case) qualify.
- **No skew arm in the new gate:** these variants INLINE their colours as
  module consts — the ShowBlock lanes the skew hook inverts are never
  read. Parity itself is the read-witness for the lanes this class does
  consume (mvp/proj from FrameBlock, extent/clip/dequant from the
  TileBlock arena — misaddressing collapses geometry); the default-class
  gate keeps the skew witness for show-lane reads.

5e. **INC-5b — retire `ringCursor` from ring-free bundle keys (design, 2026-08-25).**
Post-INC-4d, a ring-free walk's bundle bakes NO per-tile ring reader, yet its
`BundleKeyState.ringCursor` still pins the per-frame ring base — so any
alloc-count change in an EARLIER show (residency transition, a non-qualified
show's tile churn) shifts every later ring-free show's key and re-records
bundles whose baked commands could have replayed verbatim. Design:

- When the walk qualified (`_lastWalkRingFree`), build the key with a
  `ringCursor: -2` sentinel ("address-free") instead of the live cursor.
  Key equality ⇒ identical qualification inputs (all key'd) ⇒ record and
  hit agree on the sentinel; a call that LOSES qualification changes the
  key naturally (cursor reappears).
- The ring-alloc invariant stays exempted for these walks (INC-5's
  `_lastWalkRingFree` — same soundness argument, now load-bearing for
  addressing too).
- Measure BEFORE building: instrument bundle re-record counts per frame
  on the sweep + a zoom-churn scenario, OFF vs ON, to see whether
  cross-show re-record coupling is a real cost — the gate4 run's
  record-side counters (177 split fills over a 36-minute two-arm run)
  suggest records are already rare at steady state; if re-records are
  <1/frame, INC-5b is not worth its key-shape risk (record the negative
  result here and close it).

_INC-5b measured (PR #2090's sweep) — the coupling is REAL and dominant:_ the ON
arm's n=32/128 windows logged bundleMisses ≈ N shows (one re-record per show per
window) with encode 159-185 ms where OFF's pure-replay windows sat at
5.2-5.4 ms — one tile's residency transition changes that show's ring alloc
count under walk-skip, and the live `ringCursor` shifts every downstream show's
key. Promoted from measure-first to REQUIRED.

_INC-5b implemented (2026-08-25):_ the qualification extracted into the SINGLE
ring-free authority `VTR._walkRingFree` (renderTileKeys' `splitWalkSkip`
delegates; `_lastWalkRingFree` still published per call), and the PRIMARY
bundle key's `ringCursor` becomes the `-2` sentinel when the walk is ring-free
(fallback-clip keys always use the live cursor — clip walks never qualify).
Soundness: every `_walkRingFree` input is pinned by the key itself (sliceLayer,
phase, pipeline labels; translucentBucket is constant-false on the bundle
path), so record and hit agree on the verdict; the ring-alloc invariant
exemption (INC-5's `_lastWalkRingFree`) already carries the baked-offsets
argument. Verification: sweep ON steady windows must show misses ≈ 0 with
walkSkips > 0 (the coupling gone), and both parity gates stay green.

6. **INC-6 — flat-arm Mercator recombination (added by INC-3's audit).** `cam_h/cam_l`
   are per-(tile × camera) DSFUN rels, so the flat/Mercator projection arm still
   restages per tile after INC-4. The INC-1 recipe applies: FrameBlock gains the
   absolute camera Mercator hi/lo, TileBlock gains a hi/lo tile origin (the current
   `tile_origin_merc` is a SINGLE f32 — the recombination needs the lost low bits),
   the VS derives `rel = cam − origin` behind a flag, with its own
   rtc-recombine-precision-style whole-domain proof. Until it lands, flat-arm draws
   keep the ring for cam_h/l (globe draws — the pitch/jank-critical path — go fully
   static at INC-4/5).

## Self-critique (architect pass, recorded so the author cannot skip them)

- **"Why not a content-signature skip of the re-walk instead?"** Rejected: it re-creates
  the exact bug class #2038 just closed (a missed dependency = silent stale uniforms),
  with a hand-maintained signature instead of a structural guarantee. §2 forbids the
  shim when the structural fix is designed.
- **"Is clip_bounds really tile-static?"** It is (fallback, visible)-PAIR static — the
  TILE key must include the clip target, or fallback draws alias. The allocator key
  carries it from INC-2 day one; the Korea fill-drop postmortem is the precedent.
- **"GLSL twin?"** Both languages emit from the same DSL declaration; the split is a
  declaration-level change and the twin inherits it. The WebGL2 arm has no bundles but
  STILL wins: its per-frame writes drop the same way (`1 + N_shows` vs `shows × tiles`).
- **"Ring grow / compaction interplay?"** The tile arena inherits the store's
  compaction-invalidate discipline (bundles already drop on relocation); the frame/show
  blocks stay ring-free (fixed slots), so the grow path shrinks rather than grows.
- **"What breaks the 256-byte layout assumptions?"** `polygonUniformSlots()` is
  reflect-derived by charter ("size is always reflect-derived, never a literal") — the
  audit found no literal offsets outside it; INC-1's gate includes a grep-ratchet for
  new literals.
- **Biggest risk:** the per-draw bind arity change (1 → 3 ranges) touches every
  polygon/line material descriptor and the bind-group registry. That is why INC-1
  proves the math with ZERO binding changes first, and INC-4 is the only increment
  allowed to touch descriptors.

## Rejected alternatives (with reasons, so they are not re-proposed)

- **Content-signature re-walk skip** — see self-critique; shim vs structure.
- **World-copy instancing first (Lever 2)** — post-bundles its CPU win is mostly on
  MISS frames only (replay already amortises draw emission on hits), and it does not
  touch the walk residual; re-rank after this split lands.
- **Bigger ring + cross-frame slot memo** — keeps per-frame addresses, so the
  ringCursor coupling and the walk both survive; solves nothing structural.
