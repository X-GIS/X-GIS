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
   - **INC-4c — line split, then the walk deletion + `ringCursor` retirement
     move to INC-5 as planned.**
5. **INC-5 — delete the hit re-walk; measure.** Expect the sweep's slope to drop from
   ~0.19 toward the selection+key floor; record on #1190 and re-scope the issue.
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
