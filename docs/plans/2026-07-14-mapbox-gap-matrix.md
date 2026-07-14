# Mapbox style-spec support matrix + Phase I (icon/sprite) parallel breakdown (#777)

Analyst deliverable for the #777 completion program — **no production code**. This document
INDEXES the in-repo machine-readable authority; it does not duplicate it. When a status
changes, the update path is the descriptor row + `gap-matrix.md` regeneration (below), not
this file; this file records the census snapshot, the anchored gap inventory, and the
Phase I execution breakdown.

---

## 0. Authority, gates, and how this document relates to them

**The authority is two assembled tables, not this doc:**

- `compiler/src/convert/spec-coverage.ts` — converter-side status per spec property,
  assembled from one descriptor file per section under
  `compiler/src/convert/spec-coverage/*.ts` (the "parallel-work registry",
  `spec-coverage.ts:25-36`: independent axes touching different sections never conflict).
- `runtime/src/capabilities.ts` — runtime-side status per `layer.property:variant`
  (constant / zoom-interp / data-driven), assembled from
  `runtime/src/capabilities/*.ts` (one file per layer type, `capabilities.ts:14-22`).

**Gates that keep the authority honest** (why indexing is safe):

| Gate                                                                | What it pins                                                                                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compiler/src/__tests__/spec-coverage-completeness.test.ts:45-58`   | every `paint_*`/`layout_*` property of all 9 layer types in the canonical spec `latest.json` has a table row — the table cannot under-enumerate the v8 surface   |
| `compiler/src/__tests__/spec-coverage-drift.test.ts`                | table ↔ converter source cross-reference (no stale/dead rows)                                                                                                    |
| `runtime/src/__tests__/spec-coverage-runtime-drift.test.ts:248-276` | a coverage row may not claim `supported` while the CONSTANT-variant capability row says false; zoom-interp/data-driven MAY lag (reflected in notes)              |
| `runtime/src/__tests__/gap-matrix-freshness.test.ts`                | `scripts/gap-matrix.md` must byte-match the generator — regenerate via `bun scripts/emit-gap-matrix.ts > scripts/gap-matrix.md` in the same PR as any table edit |

**Census snapshot** — measured at `fdcb3a17` (2026-07-14) by importing `MAPBOX_COVERAGE`:
**243 tracked / 176 supported / 20 partial / 35 unsupported / 12 na → 55 remaining.**
The epic body (filed 2026-07-02) said 60 remaining at 243/176/18/42/7; the delta since is
I1+I2 (icon-only layers + `["image"]` in icon-image context, PR #965), the D1/IV6
reclassifies (`fill/line/circle-sort-key`, `symbol-avoid-edges` → `na` with architecture
notes), and `feature-state` → `na`.

---

## 1. Support matrix (indexed)

### 1.1 Per-section census (from `MAPBOX_COVERAGE`, fdcb3a17)

| Section (descriptor file) | supported | partial | unsupported |     na |   total |
| ------------------------- | --------: | ------: | ----------: | -----: | ------: |
| top-level                 |        11 |       0 |           5 |      1 |      17 |
| sources                   |         7 |       1 |           2 |      0 |      10 |
| layer types               |         8 |       1 |           2 |      0 |      11 |
| layer-common              |         7 |       0 |           0 |      2 |       9 |
| layout — fill/line        |         5 |       0 |           0 |      3 |       8 |
| layout — symbol           |        33 |       3 |           7 |      1 |      44 |
| paint — background        |         2 |       0 |           1 |      0 |       3 |
| paint — fill              |         6 |       1 |           0 |      0 |       7 |
| paint — line              |        10 |       0 |           1 |      0 |      11 |
| paint — symbol            |        10 |       1 |           3 |      0 |      14 |
| paint — circle            |         8 |       2 |           1 |      0 |      11 |
| paint — fill-extrusion    |         8 |       0 |           2 |      0 |      10 |
| paint — raster            |         8 |       0 |           1 |      0 |       9 |
| paint — heatmap           |         4 |       1 |           0 |      0 |       5 |
| paint — hillshade         |         0 |       0 |           9 |      0 |       9 |
| expressions               |        42 |      10 |           1 |      5 |      58 |
| filters                   |         7 |       0 |           0 |      0 |       7 |
| **TOTAL**                 |   **176** |  **20** |      **35** | **12** | **243** |

Rolled up **by layer type** (layout+paint rows for that type; `visibility` counted once as
cross-type):

| Layer type         | supported |              partial |                      missing |          na (deliberate) |
| ------------------ | --------: | -------------------: | ---------------------------: | -----------------------: |
| fill               |         6 | 1 (`fill-antialias`) |                            0 |      1 (`fill-sort-key`) |
| line               |        14 |                    0 |          1 (`line-gradient`) |      1 (`line-sort-key`) |
| symbol (text+icon) |        43 |                    4 |                           10 | 1 (`symbol-avoid-edges`) |
| circle             |         8 |                    2 | 1 (`circle-pitch-alignment`) |    1 (`circle-sort-key`) |
| heatmap            |         4 |  1 (`heatmap-color`) |                            0 |                        0 |
| fill-extrusion     |         8 |                    0 |     2 (ambient-occlusion ×2) |                        0 |
| raster             |         8 |                    0 |   1 (`raster-fade-duration`) |                        0 |
| background         |         2 |                    0 |     1 (`background-pattern`) |                        0 |
| hillshade          |         0 |                    0 |              9 (whole layer) |                        0 |

The 9 layer types above are exactly the set the completeness gate enumerates against the
spec, so "missing" here is exhaustive over the v8 paint/layout surface. `terrain`/`sky`
appear only as top-level/layer-type rows (`terrain` unsupported/medium — Phase II6 files a
separate epic; `sky` unsupported/low, `layers.ts:SKIP_REASONS`); `model` is not in the v8
oracle and is out of scope.

### 1.2 The non-supported inventory, with anchors

Statuses below are the authority's; anchors are the converter lowering site, the runtime
consumption site, the gap-warning site, or a grep proving absence. Rows already carrying a
`source` anchor in their descriptor are not re-derived here — read the descriptor note for
the full mechanism.

**Phase I scope — icon/sprite (details in §2):**

| Property                                  | Status                                                                             | Anchor                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `symbol` icon-only layers                 | partial(medium) — layout tail deferred                                             | routed since #777 I1/I2: `compiler/src/convert/layer-converters/symbol.ts:50-69` (iconOnly branch), note at `spec-coverage/layer-types.ts` row                                        |
| `["image", …]` expression                 | partial(**high**) — icon-image context resolved; text-inline format spans deferred | `compiler/src/convert/layer-converters/symbol.ts:34-39` (`unwrapImageExpr`), gap = format spans (`spec-coverage/expressions.ts` `image` row note)                                     |
| `icon-text-fit` / `icon-text-fit-padding` | missing(medium/low)                                                                | converter warn-and-drop `compiler/src/convert/layers-symbol.ts:456-464`; no `iconTextFit` field exists in `compiler/src/ir/render-node.ts` LabelDef (grep)                            |
| `icon-padding`                            | missing(low)                                                                       | converter warn `layers-symbol.ts:958-975`; runtime hardcodes spec default: `map/src/sprite/icon-stage.ts:290` (`const pad = 2 * this.dpr`)                                            |
| `icon-keep-upright`                       | missing(low)                                                                       | absence: `grep -rn 'icon-keep-upright' compiler/src map/src runtime/src` hits only the coverage row (verified 2026-07-14); text twin exists at `map/src/text/text-stage.ts:1500-1530` |
| `icon-pitch-alignment`                    | missing(low)                                                                       | converter surfaces `map` via consolidated note `layers-symbol.ts:527,553-560`; no ground-plane quad path in `map/src/sprite/icon-renderer.ts`                                         |
| `icon-halo-color/-width/-blur`            | missing(low ×3)                                                                    | converter warns `layers-symbol.ts:436-454`; icon FS has a single coverage smoothstep, no halo band: `map/src/shaders/dsl/icon.ts:91-95`                                               |
| `background-pattern`                      | missing(low)                                                                       | converter drop `compiler/src/convert/convert-background-layer.ts:149-150`; background pass is clear-only, no draw: `map/src/render/passes/background-pass.ts:93-106`                  |
| `icon-translate` (non-constant)           | partial(low)                                                                       | constant wired (`layers-symbol.ts` emit → `label-pass.ts` dispatchIcon, per row note); expression form warns+drops                                                                    |

**Phase II+ scope** — anchored one-liners in §3.

### 1.3 The value-form dimension (runtime capability gaps)

The coverage table is per-property; the capability table is per-`property:variant`. The 13
rows where the runtime drops/degrades a value-form are generated into
`scripts/gap-matrix.md` §"Runtime capability gaps" — index there; icon-relevant rows:

| Row (`runtime/src/capabilities/symbol.ts`)           | Note                                   | Assessment                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `icon-size:data-driven` (:77-83, supported=false)    | "Worker per-feature evaluator pending" | real gap — cluster I-F                                                                                                                                                                                                                        |
| `icon-opacity:zoom-interp` (:61-67, supported=false) | "Per-feature alpha attr path deferred" | **suspected stale**: `map/src/render-loop-helpers.ts:218-223` resolves the zoom-interp iconOpacity shape per frame. First task of cluster I-F: wiring-test the truth, then flip the row or fix the path — never edit the row without the test |
| `icon-opacity:data-driven` (:68-74, supported=false) | per-feature alpha                      | real gap — cluster I-F (the const/zoom paths resolve per label, the per-feature expr path exists only for icon-image/color)                                                                                                                   |
| `symbol-sort-key:data-driven` (:85-91)               | flattens to 0                          | Phase IV1                                                                                                                                                                                                                                     |
| `text-opacity:data-driven`, `text-pitch-alignment`   | text side                              | Phase IV                                                                                                                                                                                                                                      |

Non-symbol runtime gaps (`fill-opacity:dd`, `fill-antialias:false`… see the generated
table) are Phase III/V/#725/#726 territory, not Phase I.

---

## 2. Phase I breakdown — icon/sprite remainder, parallel-safe clusters

**Already landed (do not re-plan):** I1 icon-only routing + I2 `["image"]` in the
icon-image context (PR #965); icon collision policies (`icon-allow-overlap` /
`icon-overlap` / `icon-ignore-placement` / `icon-optional`, Phase S Batch 4);
icon-color/opacity/size constant+zoom forms; `icon-translate(-anchor)` constant form.

**The shared lowering pipeline** every symbol-property cluster rides (cited per cluster as
"the pipeline"):

```
converter emit            compiler/src/convert/layers-symbol.ts:239 convertIconProperties (utility strings `label-icon-*`)
  → knob parse            compiler/src/ir/lower-label.ts:108-155 (labelIcon* block)
  → IR field              compiler/src/ir/render-node.ts:386 (interface LabelDef)
  → per-frame resolve     map/src/render-loop-helpers.ts:183-249 (icon PropertyShapes)
  → dispatch              map/src/render/passes/label-pass.ts:332-423 (dispatchIcon)
  → stage                 map/src/sprite/icon-stage.ts:196 (addIcon) / :245 (prepare)
  → quad build            map/src/sprite/icon-renderer.ts:225 (setDraws), :469 (anchorOffset)
  → shader                map/src/shaders/dsl/icon.ts (+ icon-retained.ts retained variant)
```

**Test shape (all clusters):** the GPU-free fail-before wiring-test convention of
`runtime/src/engine/sprite/icon-anchor-wiring.test.ts:1-35` — drive the REAL
IconRenderer/dispatch path against the WebGPU stub, intercept `writeBuffer`, assert the
property's exact effect on the vertex bytes, and document the fail-before mutation in the
test header. Converter side: a unit test on `convertSymbolLayer` output (emit present /
warning gone).

**Per-cluster PR checklist (epic protocol):** implementation + wiring test (fail-before
proven) + descriptor row update (`spec-coverage/layout-symbol.ts` or `paint-symbol.ts` /
`paint-background.ts`) + capability rows (`runtime/src/capabilities/symbol.ts` /
`background.ts`) + `bun scripts/emit-gap-matrix.ts > scripts/gap-matrix.md` + §5
directional pixel-diff evidence (compare-diff.py, DC>0 where content changes, D1<D0 vs
MapLibre where a golden exists, 16-split diff read).

### 2.0 Shared files — the merge-sequencing surface

True file-disjointness is impossible for symbol properties (one pipeline); the clusters
below are **parallel-development-safe**: each edits DISTINCT SITES (append-only rows /
distinct functions) in the shared files, so concurrent worktrees never edit the same
lines, and merges are mechanical rebases in any order. The orchestrator must still
sequence merges through these files:

| Shared file                                                                                     | Who touches it                                            | Hazard                                                                                             |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `compiler/src/convert/layers-symbol.ts` (LOC ceiling **1295**)                                  | I-A, I-B, I-C, I-D (+I-H impl)                            | append inside `convertIconProperties`; ceiling raise likely                                        |
| `compiler/src/ir/lower-label.ts` (ceiling **1091**)                                             | I-A, I-B, I-C, I-D, I-F                                   | append in the knob block :108-155; ceiling raise likely                                            |
| `compiler/src/ir/render-node.ts` (ceiling **908**)                                              | same set                                                  | LabelDef field appends                                                                             |
| `map/src/render/passes/label-pass.ts` (ceiling **1747**)                                        | I-A, I-B, I-D, I-F, I-G                                   | dispatchIcon (:332-423) / per-feature expr region (:722-870); ALSO touched by #1046 F2/F6 — see §4 |
| `map/src/loc-ceiling-ratchet.test.ts`                                                           | any cluster that grows a ceilinged file; also #1046 F3/F6 | THE serialization point — one-line-per-file edits, rebase last, never batch-raise                  |
| `compiler/src/convert/spec-coverage/layout-symbol.ts`, `paint-symbol.ts`, `paint-background.ts` | per cluster                                               | row edits at distinct positions; trivial                                                           |
| `runtime/src/capabilities/symbol.ts`, `background.ts`                                           | per cluster                                               | row appends; trivial                                                                               |
| `scripts/gap-matrix.md`                                                                         | EVERY cluster                                             | guaranteed textual conflict; never hand-merge — re-run the generator after each merge              |
| `playground/src/demos/fixtures.ts`                                                              | clusters adding a probe fixture (I-A, I-E, I-F)           | registry append; trivial                                                                           |

### Cluster I-A `icon-textfit` — `icon-text-fit` + `icon-text-fit-padding` — **L**

- **Properties:** `icon-text-fit` (missing/medium — the shield/badge-background gap),
  `icon-text-fit-padding` (missing/low, dependent).
- **Mechanism:** converter replaces the warn at `layers-symbol.ts:456-464` with
  `label-icon-text-fit-<width|height|both>` + `label-icon-text-fit-padding-[t,r,b,l]` →
  LabelDef `iconTextFit`/`iconTextFitPadding` → dispatchIcon obtains the PAIRED label's
  shaped text bbox — the text quad authority already computes it in the TextStage layout
  cache (`map/src/text/text-stage.ts:245-263`: `totalAdvance`/`blockTop`/`blockBottom`;
  the epic's "shield ink-centring glyphOffsets bake") — through the existing `pairKey`
  text↔icon coupling → `addIcon` gains fit dims → `setDraws` stretches `drawW/drawH`
  before `anchorOffset` (`icon-renderer.ts:260`), padding added per side.
- **Files:** the pipeline files + `map/src/text/text-stage.ts` (bbox read hook — the ONLY
  Phase I cluster allowed to touch text-stage besides I-G) + new
  `runtime/src/engine/sprite/icon-text-fit-wiring.test.ts`.
- **Test shape:** wiring test asserting quad dims = text bbox + padding for
  `both`/`width`/`height` and = native sprite dims for `none`; fail-before = bypass the
  fit branch. Converter test: emit + no warning.
- **§5 probe:** new fixture `fixture_symbol_icon_textfit` (`&sprite=/fixture-sprite`, the
  `demo-runner.ts:1459` local-atlas mechanism): one shield sprite + 2-digit vs 5-digit
  `text-field`, `icon-text-fit: both`. Target styles do NOT author this property (grep of
  `playground/public` mirrors: none), so the probe is purpose-built; A/B vs MapLibre on
  the same fixture, D1<D0 on the shield quads, DC confined to shields.
- **Why L:** crosses the text↔icon subsystem boundary; layout-cache keying (a bbox-sized
  icon must not serve a stale bbox after zoom-dependent text-size changes) is the risk.

### Cluster I-B `icon-keep-upright` — **S**

- **Property:** `icon-keep-upright` (missing/low): line-placed icons currently follow the
  tangent without flipping.
- **Mechanism:** converter emits `label-icon-keep-upright(-false)` (twin of the text form,
  `layers-symbol.ts:1250-1257`) → LabelDef flag → in dispatchIcon, normalize the
  `rotationAlignment==='map'` line tangent into the upright half-plane (+180° when the
  tangent points down) before the `rotateRad` compose at `label-pass.ts:383,415` —
  mirroring the text flip at `text-stage.ts:1500-1530`. IconStage/renderer untouched.
- **Default caution:** spec default is `true`, but an unconditional flip changes today's
  byte-identical renders. Follow the repo's absent-default convention
  (`icon-allow-overlap` precedent, `spec-coverage/layout-symbol.ts:175`): activate on
  explicit authoring first; flipping the absent-default requires its own §5 before/after
  sweep on `ofm_bright_local`. Record the choice in the descriptor note.
- **Files:** `layers-symbol.ts`, `lower-label.ts`, `render-node.ts`, `label-pass.ts` + new
  `icon-keep-upright-wiring.test.ts`.
- **Test shape:** feed a downward tangent (e.g. 170°) through dispatchIcon, assert
  `rotateRad` lands flipped; fail-before = remove the half-plane fold.
- **§5 probe:** `ofm_bright_local` `road_oneway` arrows at `#16/35.68/139.76` with
  `bearing=180` (tangents point down); DC>0 confined to arrow quads; MapLibre A/B for
  direction.

### Cluster I-C `icon-pitch-alignment` — **M** (recommend pairing/deferring with IV3)

- **Property:** `icon-pitch-alignment: map` (missing/low; `viewport`/`auto` already match
  the billboard default and are suppressed at `layers-symbol.ts:553-560`).
- **Mechanism:** converter emits `label-icon-pitch-alignment-map` → LabelDef flag →
  ground-plane quad variant in the icon vertex path (`icon-renderer.ts:225` setDraws or a
  VS variant in `map/src/shaders/dsl/icon.ts`/`icon-retained.ts` — DSL emit gives
  WGSL+GLSL twins by construction, keeping #1046 F3+ compatibility).
- **Files:** pipeline files (light dispatch flag) + `icon-renderer.ts` +
  `icon.ts`/`icon-retained.ts` + `icon-dsl.test.ts` extension.
- **Test shape:** shader-emit snapshot for the variant + wiring test that the flag reaches
  the draw path; fail-before = drop the variant selection.
- **§5 probe:** `fixture_symbol_icon` at `pitch=60`; DC>0 on icon quads (foreshortening
  appears); MapLibre A/B.
- **Sequencing note:** the epic pairs I6 with IV3 (`text-pitch-alignment: map`) — same
  billboard-vs-ground quad math. Either land the shared ground-quad utility HERE and let
  IV3 consume it, or defer this cluster into the Phase IV batch. Do not build the math
  twice.

### Cluster I-D `icon-padding` — **S**

- **Property:** `icon-padding` (missing/low; warn `layers-symbol.ts:958-975`).
- **Mechanism:** converter emits `label-icon-padding-N` only when N≠2 (OFM Bright authors
  the spec default 2 — byte-identical stays byte-identical, `layers-symbol.ts:963`) →
  LabelDef.iconPadding → dispatchIcon → `addIcon` opts → `icon-stage.ts` replaces the
  hardcoded `2 * this.dpr` at `:290` (line-icon overlap AABB) and the stage-2 collide
  queue box (`:359-381` region) with the per-icon value.
- **Files:** `layers-symbol.ts`, `lower-label.ts`, `render-node.ts`, `label-pass.ts`,
  `icon-stage.ts` + new `icon-padding-wiring.test.ts`.
- **Test shape:** two collide-icons at a distance where padding 20 collides and padding 2
  does not; assert the placement verdict flips with the property; fail-before = ignore
  `opts.padding`.
- **§5 probe:** DC=0 regression pass on `ofm_bright_local` `#14/35.68/139.76` (authored
  value = default) + a padding-20 fixture variant where DC>0 as icon density drops.

### Cluster I-E `background-pattern` — **M** (sequence AFTER #1046 F2 — see §4)

- **Property:** `background-pattern` (missing/low; dropped at
  `convert-background-layer.ts:149-150`).
- **Mechanism:** converter lowers the sprite name (constant form; zoom-crossfade form
  warns) → background IR/ShowCommand field alongside the existing background shapes
  (`background-pass.ts:76-87` colour/opacity shapes) → the background pass gains its first
  DRAW: after the clear (`background-pass.ts:93-106` is clear-only today), a fullscreen
  quad samples the sprite atlas with wrapped UV (atlas access via the host sprite atlas,
  `map/src/sprite/host-sprite-atlas-gpu.ts` / `sprite-atlas-host.ts`, read-only). Pipeline
  as a small self-contained DSL module (new `map/src/shaders/dsl/background-pattern.ts`)
  — deliberately NOT in `pipeline-factory.ts` (avoids that ceilinged, #1046-contended
  file).
- **Files:** `convert-background-layer.ts`, `background-pass.ts`, new shader module +
  pipeline wiring, `spec-coverage/paint-background.ts`, `capabilities/background.ts`,
  fixture.
- **Test shape:** converter emit test + background-pass stub test (pattern draw recorded
  after clear); fail-before = pattern name never reaches the pass.
- **§5 probe:** new `fixture_bg_pattern` (`&sprite=/fixture-sprite`); DC>0 across the full
  viewport; MapLibre A/B on the same style.
- **Cross-program constraint:** MUST be authored against the RHI-typed FrameContext that
  #1046 F2 introduces, and the pipeline must be dual-source (DSL emit) so F3/F4 run it on
  WebGL2 — otherwise this cluster recreates the RHI_TWIN_MISSING class the twin-kill is
  deleting. Land after F2 merges (§4).

### Cluster I-F `icon value-forms` — data-driven size/opacity, icon-translate expr — **M**

- **Rows:** `icon-size:data-driven` (capabilities/symbol.ts:77-83),
  `icon-opacity:zoom-interp` (:61-67 — suspected stale, §1.3) + `:data-driven` (:68-74),
  `icon-translate` non-constant (paint-symbol partial row).
- **Mechanism:** the per-feature icon expression pattern already exists —
  `label-pass.ts:722-870` evaluates `iconImageExprAst` per feature against the props bag
  (iter 490) and `lower-label.ts:136` already parses `labelIconOpacityExpr`. Extend the
  same evaluate-then-dispatch to `iconSizeExpr`/`iconOpacityExpr`; zoom-interp forms ride
  the existing `resolveNumberShape` block (`render-loop-helpers.ts:183-249`).
  `icon-translate` expression form lowers to a shape pair the same way.
- **Files:** `lower-label.ts`, `label-pass.ts` (:722-870 region), `render-loop-helpers.ts`
  (ceiling **818** — watch it), `layers-symbol.ts` (emit forms), `capabilities/symbol.ts`.
- **Test shape:** one wiring test per value-form (match/get-driven size; interpolate-driven
  opacity), asserting the per-vertex bytes; the stale-row question (§1.3) resolves FIRST
  with a zoom-interp opacity test — flip the capability row only on green.
- **§5 probe:** an OFM POI camera where a `["match"]`-driven icon-size differs per class
  (`ofm_bright_local` `#15/35.685/139.75`), or a categorical fixture; DC>0 on the affected
  icons.

### Cluster I-G `inline format images` — `["image"]` spans in text — **L, flagged**

- **Row:** expressions `image` partial(**high**) — the only high-impact row left in the
  census. Icon-image context landed (I2); text-inline `["format", …, ["image", …]]` spans
  still take the per-span partial-drop warning (`spec-coverage/expressions.ts` `image` +
  `format` row notes; format lowering at `compiler/src/convert/expressions.ts:208`).
- **Mechanism sketch:** format-span representation gains an image span kind → text shaping
  reserves an inline quad slot in the glyph run (text-stage layout cache) → the icon quad
  renders from the sprite atlas inside the label block (either via IconStage with a
  per-glyph anchor, or a dedicated inline-quad page in the text renderer). This IS "the
  span machinery" the epic warned may drag — it is shared with Phase III3 (`format`
  per-span `font-scale`/`text-color`).
- **Files:** `expressions.ts`, `lower-label.ts`/`render-node.ts` (span repr),
  `text-stage.ts`, `label-pass.ts`, possibly `text-renderer.ts`.
- **Sequencing:** LAST in Phase I, never concurrent with I-A (both churn text-stage
  layout), and consider co-scheduling with III3 so the span plumbing is built once.
- **§5 probe:** fixture with `text-field: ["format", "Exit ", ["image", "arrow"]]`;
  MapLibre A/B.

### Cluster I-H `SDF icon halo` — icon-halo-color/width/blur — **S (reclassify) / M (implement)**

- **Rows:** 3 × missing(low), `spec-coverage/paint-symbol.ts:59-75`; converter warns
  `layers-symbol.ts:436-454`; FS gap at `icon.ts:91-95` (single smoothstep, no halo band).
- **Epic disposition (I7):** the iter-162 probe found ZERO SDF sprites in the target
  styles — halos apply only to SDF sprites, so implementing produces no visual change
  there. **Recommended: notes-only reclassify PR now** (descriptor rows annotated
  `na`-adjacent-deferred + gap-matrix regen — the D-phase shape; zero conflict with
  anything), leaving the implementation recipe in the note: second smoothstep at
  `edge - haloWidth` mirroring `fs_text`, per-vertex halo attrs extending the 9-float
  format (`icon-renderer.ts:72-78`, `icon-vertex-format.ts`), converter paint emit.
  Re-open when a style with SDF sprites becomes a target (the probe script pins it).

### Parallelism summary

| Cluster                | Size | Parallel-dev-safe with                 | Never concurrent with      |
| ---------------------- | ---- | -------------------------------------- | -------------------------- |
| I-A textfit            | L    | B, C, D, E, F, H                       | G (text-stage)             |
| I-B keep-upright       | S    | all                                    | —                          |
| I-C pitch-alignment    | M    | all (defer option: IV3 pairing)        | —                          |
| I-D padding            | S    | all                                    | —                          |
| I-E background-pattern | M    | all (fully file-disjoint from A-D,F-H) | #1046 F2 window (§4)       |
| I-F value-forms        | M    | A, B, C, D, E, H                       | G (label-pass expr region) |
| I-G inline images      | L    | E, H                                   | A, F                       |
| I-H halo reclassify    | S    | all (docs/tables only)                 | —                          |

Suggested merge order: **H → D → B → F → A → C → [after #1046 F2] E → G** (smallest,
lowest-risk first; each merge = rebase shared-file appends + regenerate gap-matrix.md).

---

## 3. Phase II+ ledger (one line per property — no design here)

**Phase II — DEM/hillshade** (one infrastructure, ten rows):

- `raster-dem` source decode (terrarium + mapbox-rgb) — partial/medium, `compiler/src/convert/sources.ts:57`
- `hillshade` layer type — missing/medium, `compiler/src/convert/layers.ts:19` (skip)
- `hillshade-illumination-direction` / `-altitude` / `-anchor` — missing (med/med/low), `spec-coverage/paint-hillshade.ts`
- `hillshade-exaggeration` / `-shadow-color` / `-highlight-color` / `-accent-color` — missing (med×3+low), same file
- `hillshade-method` + `resampling` — missing/low ×2, same file
- `terrain` — missing/medium, top-level; file as separate epic when II lands (epic II6)

**Phase III — expression/colour finishes:**

- `rgb`/`rgba` dynamic channels — partial/low, `compiler/src/convert/expressions.ts:507`
- `hsl`/`hsla` dynamic channels — partial/low, `compiler/src/convert/colors.ts:69`
- `interpolate (cubic-bezier)` exact runtime curve — partial/low, `compiler/src/convert/expr-interpolate.ts` (densify)
- `format` per-span font-scale/text-color — partial/low, `expressions.ts:208` (couples with I-G)
- `collator` / `resolved-locale` dynamic options — partial/low ×2, `expr-registry` handlers
- `array` abort-on-mismatch — partial/low, `expressions.ts:163`
- `distance` / `within` on MVT sources — partial/low ×2, eval/distance.ts + eval/within.ts (GeoJSON-only today)
- `distance-from-center` — missing/low, expressions section

**Phase IV — label/symbol advanced:**

- `symbol-sort-key` expression form — partial/medium, `layers.ts:702` + `capabilities/symbol.ts:85-91`
- `text-overlap` cooperative — partial/low, `layers.ts:418`
- `text-pitch-alignment: map` — partial/medium, `map.ts:2461` (pairs with I-C)
- `text-writing-mode` (vertical CJK) — missing/medium, layout-symbol row
- `text-optional` — missing/low (unblocked by I1)
- `text-opacity:data-driven` runtime row — `capabilities/symbol.ts:19-25`

**Phase V — point/raster/misc:**

- `circle-blur` expression forms — partial/low, `compiler/src/convert/layers-circle.ts`
- `circle-pitch-alignment: map` — missing/low + `circle-translate-anchor: map` — partial/low (one PR, both in the point vertex path)
- `heatmap-color` custom ramp → LUT — partial/medium, `compiler/src/convert/layers-heatmap.ts`
- `raster-fade-duration` — missing/low, paint-raster row
- `transition` — missing/low, top-level

**D — remaining reclassify/defer tail** (D1/IV6 already landed as `na`): `fog`, `sky`,
`image` source, `video` source, `imports`, `metadata` ×2,
`fill-extrusion-ambient-occlusion-*` ×2, `line-gradient` (deferred note, `paint.ts:218` —
shares the `line-progress` tiler prerequisite with #726), `fill-antialias` note-closure.

---

## 4. Cross-program conflict note — #1046 twin-frame elimination (F2–F6)

Per `docs/plans/2026-07-14-twin-frame-elimination.md` §3–§4, the twin-kill program's file
map intersects Phase I in exactly four places:

1. **`map/src/render/passes/label-pass.ts`** — F2 retypes the pass's encoder/render-pass
   block (`:1717-1734`) and shrinks the fake-context site; F6 deletes the `useRhi` fork
   (`:1711-1716`). Icon clusters I-A/B/D/F/G edit `dispatchIcon` (`:332-423`) and the
   per-feature expr region (`:722-870`) — **disjoint regions, low semantic conflict,
   mechanical rebases**. Ordering rule: land the S clusters (I-D, I-B) before F2 starts if
   possible; any icon cluster in flight when F2 merges rebases over it (F2 is
   §5-verified DC=0 refactor-neutral, so behaviour cannot shift under the rebase).
2. **`map/src/render/passes/background-pass.ts`** — F2 touches all 9 pass files;
   F3/F4 begin executing this pass on WebGL2. Cluster I-E adds the pass's FIRST draw.
   **Strong recommendation: I-E lands after F2** (author once against the RHI-typed
   context) with a dual-source DSL pipeline, and its §5 gate re-runs on `backend=webgl2`
   once F4 flips. Landing I-E before F1 forces #1046 to port it mid-flight — the exact
   twin-tax the program exists to kill.
3. **`map/src/loc-ceiling-ratchet.test.ts`** — F3 raises `rhi-webgl2/src/rhi-webgl2.ts`,
   F6 LOWERS `render-loop.ts`/`vector-tile-renderer.ts`; icon clusters raise
   `label-pass.ts`/`layers-symbol.ts`/`lower-label.ts`/`render-node.ts` as needed. All
   edits are one line per file — designate this file the merge-serialization point: every
   PR rebases it immediately before merge; never batch ceiling changes for another
   program's files.
4. **`map/src/render/pipeline-factory.ts`** — contended by #1046 (backend-identity sites
   `:220/:540/:1273/:1315` + F5 ports). Phase I avoids it by design (I-E's pipeline is
   self-contained; no other cluster needs it). If an implementation is forced into it,
   sequence behind the F-phase touching those lines.

**No overlap at all** on the rest of Phase I's surface: `compiler/src/convert/*`,
`compiler/src/ir/*`, the coverage/capability descriptor files, `scripts/gap-matrix.md`,
`map/src/sprite/*`, `map/src/text/text-stage.ts`, and the icon DSL shaders are untouched
by #1046 F1–F6 (the twin plan's only sprite mention, the `render-loop.ts:1061` sprite-
atlas push, is inside files Phase I does not edit). One semantic (not file) dependency:
any NEW icon/background shader work must come from shader-dsl emit so both backends get
twins — which the DSL guarantees by construction.

**Recommended global ordering** (interleaving both programs):
I-H, I-D, I-B (small, now) → #1046 F1/F2 ∥ I-F, I-A in worktrees (rebase over F2 on merge)
→ F3/F4 → I-E → F5 ∥ I-C (or I-C deferred into IV3) → I-G last (label-engine risk),
any time after F4 → F6.
