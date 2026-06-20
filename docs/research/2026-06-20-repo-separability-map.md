# Whole-repo separability map — engineering parallel-axis throughput

**Date:** 2026-06-20
**Method:** 9-subsystem parallel chokepoint survey (12-agent Workflow) → synthesis →
adversarial critic. Verdict **SOUND-WITH-CORRECTIONS**; the 7 critic corrections are
folded in below (load-bearing: the B4 cache-decision gate and the B2 byte-identical-IR
gate). Companion to `2026-06-20-parallel-axis-architecture.md` (the 4 moves + workflow).
**Status:** map only — capabilities (`47a78247`) + spec-coverage (`36ca51c7`) registries
shipped; everything below is the remaining roadmap.

Surveyed across `compiler/ runtime/ blueprint/ shared/ playground/ site/ vscode-xgis/`.
The repo has already proven the **registry mechanic** twice (capabilities, spec-coverage)
and the **per-concern owner-object mechanic** (RenderLoop / MapEventBus extracted from
map.ts). What remains: apply those to the *emission authorities* and the *IR spine* every
parity axis threads through — and leave the genuine CPU↔WGSL byte contracts shared, on
purpose.

> **Line-number note:** ranges below were re-grounded by the critic where the survey
> drifted (F4/F6/F7). Treat any single line cite as approximate — confirm via the graph
> before a blind line-seek.

## 1. Ranked chokepoint table (rank = blastScore × decomposition-value)

Decomposition-value is *high* for clean seams (string/type emission, no hot loop, no byte
contract) on the hot parity path; *zero-to-negative* for must-stay-shared contracts (§4).

| # | file (LOC / hot method) | kind | what forces serialization | seam | move |
|---|----------|------|---------------------------|------|-------|
| 1 | `runtime/.../render/vector-tile-renderer.ts` class 111–4010 (~3900); hot = `renderTileKeys` 3486–4008 + twin `doUploadTile`/`doUploadTileAsync` | god-file | per-pass dispatch + per-layer-type pipeline routing + per-layer-type packing fused; every Phase-R subsystem edits the same methods (~174 pipeline-branch sites) | per-pass strategy (Fill/Stroke/Extrude/OIT/Pattern) + per-layer-type TileUploader, dispatched by a phase→pass registry over a shared pipeline-descriptor table | 4 (behind 1) |
| 2 | `compiler/src/ir/lower.ts` ~1452; `lowerLayer` ~180–1192 | god-file | one binding loop: every paint prop is a hand `else if(name==='X')` arm + a `let` in the accumulator + a key in the return literal; X-GIS0005 catch-all is the single drop-gate for every axis | per-concern BindingHandler descriptor registry over a shared mutable LayerAccumulator (mirror lower-label / lower-animation extractions) | 4 (behind 1) |
| 3 | `ShowCommand` spine: `renderer-types.ts` (~235-LOC iface) ≡ `emit-commands.ts` `emitShow` 391–504 (43-field copy-map) ≡ convert consumers | shared-type-spine (3-party) | new paint prop = field here + hand-copied `node.X→show.X` in emitShow + resolved-show mirror + read in 25 importers | sub-bundle the TYPE per layer type (Fill/Line/Circle/Extrude/SymbolPaint) + composable `emitFillFields…` emitters — keep ONE shared type, never fork per consumer | 3 |
| 4 | `runtime/src/engine/map.ts` ~3463; `rebuildLayers` ~2390–2730 | god-file + registry | rebuildLayers = addLayer surface: if/continue per geometry/source kind + `pointRenderer.addLayer` 20+ positional args growing per circle-paint prop; new-layer-type PR and new-paint-prop PR collide | `Map<layerKind, LayerBuilder>` registry + descriptor-object args; continue per-concern owner-objects | 1 + 4 |
| 5 | `compiler/src/ir/render-node.ts` ~737 (RenderNode 85–217; LabelDef 288–499) | shared-type-spine | ~50 flat paint fields + ~45 text/icon knobs; every axis adds a field; "expanding it re-wires all three" (lower→emit→runtime) | nested per-concern groups (Fill/Line/Circle/ExtrudePaint; Text/Icon Layout/Paint; Collision) — preserve inline `*TranslateXShape` cycle-avoidance | 3 |
| 6 | `compiler/src/convert/paint.ts` ~794; `paintToUtilities` 112–280 | god-file | one if/else per-layer-type dispatch + every `add*` emitter in one body; AGENTS mandates a new `add*` here per prop | per-layer-type emitter modules (paint-fill/line/fill-extrusion/raster) + thin dispatcher + shared paint-helpers | 1 |
| 7 | `compiler/src/convert/expressions.ts` ~1116; `exprToXgis` 49-arm switch | god-file | one switch(op), ~49 arms reached from paint/layers/symbol/filter; any gap blocks all four; two operator PRs collide | `Map<op, handler>` registry (continue expr-interpolate/expr-match) — keep `_exprDepth` central in the recurse entry | 1 |
| 8 | `vector-tile-renderer-types.ts` `GPUTile` iface 14–106 | shared-type-spine | bundles every layer-type's slice fields; a new layer-type's GPU slice ripples through producer + store alloc/free + draw | base `TileSlot` + optional per-type slices (Polygon/Extruded/Line) attached by presence | 3 (keep dequant/offset co-located, §4) |
| 9 | `playground/render-verify/matrix.manifest.ts` ~924 (46 cells) | single-authority-table | one `MATRIX` is the sole render-gate authority; every coverage feature appends + collides | per-axis fragments (matrix.merc/globe/disc/line) concat in an index; OracleSpec stays in matrix-types | 1 |
| 10 | `playground/src/demos.ts` ~595 (125 demos) | single-authority-table | one `DEMOS` record; every feature inserts a key; reorder shifts positional demoIds | per-category modules merged in demos/index; id-keyed URL | 1 |
| 11 | `compiler/src/tiler/vector-tiler.ts` ~1566; `compileSingleTile` ~1290 | god-file | GeoJSON→GPU: decompose + simplify+clip+earcut + buffer assembly in one body; line-tess and earcut reworks collide | per-geometry modules (polygon/line/point-tiler) behind a thin orchestrator — leave `ecef-packing.ts` shared (§4) | 4 |
| 12 | `compiler/src/parser/parser.ts` ~1178; `parseStatement` 14-arm switch | god-file | one Parser, 14-arm switch + precedence ladder over `this.tokens/pos`; lock-step with tokens.ts enum + language schema | keyword→handler registry off lexer tokens; split precedence ladder; shared cursor base | 1 + 3 |
| 13 | `passes/label-pass.ts` ~1163 `execute` ≡ `text/text-stage.ts` ~1465 `prepare` 563–1440 | god-file | each runs 4 feature-class loops (point / variable-anchor+CJK / curved / collision) over shared mutable state; #417/#458/#463 all landed here | per-concern passes over an explicit `ShapedLabel[]` intermediate; perfMark boundaries = seam; keep collision core single (§4) | 4 |
| 14 | `render/pipeline-factory.ts` ~1193 `build()` 411–870 + variant path ≡ `renderer.ts` ~35 mirror getters | shared-registry + barrel | ~30 hand-named pipeline fields via inline buildSet, duplicated in the variant path + a delegate getter in renderer.ts | per-layer-type descriptor table iterated once for build + once for variants; collapse getters into one typed PipelineSet accessor | 1 |
| 15 | `compiler/src/ir/property-types.ts` `PaintShapes` 94–105 / `LabelShapes` 124–167 | single-authority-table | the two shared shape bundles every renderer reads; a new shape-able axis edits them (PropertyShape<T> itself stays shared, §4) | per-layer-type bundle split (Fill/Line/CircleShapes) | 1 (bundles only) |
| 16 | `render/resolved-show.ts` 125–256 + `paint-shape-resolve.ts` | shared-registry (hot path) | resolveShow = sole per-frame paint resolver; hand-maintained cache hit-check + 2 writeback blocks enumerate cached shapes | per-axis table-driven enumeration **in place** (keep ONE alloc-free cache); see B4 gate | 3 |
| 17 | `compiler/src/convert/mapbox-to-xgis.ts` ~707; `convertMapboxStyle` ~580 | god-file | inlines ~10 validation pre-walks + the whole background-layer converter; a new lint and a background feature collide | lift pre-walks to validate-sources/validate-layers; move background body to convertBackgroundLayer; preserve warnings[] order | 4 |
| 18 | `runtime/src/data/tile-catalog.ts` ~1343 | god-file | router+cache+budget+eviction+sub-tile+prefetch in ~45 methods; `cacheTileData` ~18 positional args | per-concern split (Backend/Ingest/Eviction/Budget/Prefetch); struct-ify args | 4 |
| 19 | `render-loop.ts` `RenderLoopHost` Pick ~50 keys 60–118 ≡ `pass.ts` PassHost | shared-type-spine | one ~50-key `Pick<XGISMap>` every pass shares; a label counter + a renderer handle collide on the union; forces fields non-private | per-pass role interfaces (FrameClock/LabelDispatch/Stage/StatsHost) on owner-objects — segment the TYPE, never the STATE | 3 |
| 20 | `compiler/src/convert/layers.ts` `convertLayer` ~254 | shared-registry | layer-type dispatch authority: SKIP_REASONS + knownLayerTypes Set + inline line layout emission | `Map<layerType, convertFn>` self-registering; move line layout into the line converter | 1 |
| 21 | `playground/src/monaco-xgis.ts` ~830 | registry (drift surface) | hand-duplicates LANGUAGE_SCHEMA as inline keyword/property/function arrays → collides AND silently drifts | derive from `@xgis/compiler` LANGUAGE_SCHEMA (blueprint already does this); split providers per module | **2 (derive)** |
| 22 | `compiler/src/codegen/shader-gen.ts` ~713 `generateShaderVariant` | god-file | fill/stroke/opacity push into shared `uniformFields[]`/palette; emitted STRUCT order is positional → axis changes collide on ordering | per-axis descriptor merged by a reducer imposing ONE canonical struct order (the order is the contract, §4) | 1 + contract |
| 23 | `runtime/src/data/tile-select.ts` + `loader/tiles-sse.ts` | hot-loop-shared | two ~600-LOC per-frame selectors interleave projection/DPR/pitch/budget | lift orthogonal knobs into pure helpers/tables; keep the DFS/SSE driver + MVP math shared (§4) | 4 (knobs only) |
| 24 | `compiler/src/index.ts` ~114 barrel ≡ `format/index.ts` | barrel + registry | every export touches the root barrel; formatValue if-ladder per spec.type | per-area sub-barrels; format → `Map<specType, formatterFn>` | 1 |
| 25 | `blueprint/src/editor.ts` ~1370 + `playground/src/demo-runner.ts` ~1224 | god-file | editor fuses model/render/drag/palette; demo-runner fuses hash/picking/overlay/fixture/loader over module singletons | per-concern collaborators | 4 |

## 2. Move mapping (+ a new Move 5)

- **Move 1 (registry split)** — cheapest, proven. Rows 6, 7, 9, 10, 14, 15, 20, 24 + the registry halves of 4, 12. Append-only wins.
- **Move 2 (derive artifacts)** — row 21 (monaco ← LANGUAGE_SCHEMA); gap-matrix already codegen.
- **Move 3 (contract-first IR spine)** — the keystone. Rows 3, 5, 8, 15, 16, 19. Scaffold the shared shape/host/slice contracts ONCE (sub-bundled per concern), then per-axis convert + render work parallelizes. The WS-1 batch did this backwards.
- **Move 4 (god-file decomposition behind contracts)** — highest cost, last. Rows 1, 2, 11, 13, 17, 18, 22, 23, 25 + god-file halves of 4, 12.
- **NEW Move 5 (derive the CPU mirror from the WGSL StructDecl — contract-collapse, NOT split).** A byte-layout contract correct as one authority but hand-mirrored in 2–3 places, so it serializes *and* silently drifts (the #360/#392/#398 archetype): `polygon.ts` Uniforms (256B) hand-mirrored by `line.ts` TileUniforms + raw `f32` index writes in VTR; `BackendTileResult` hand-mirrored by `MvtWorkerResult`. The move is NOT to shard the bytes (forbidden, §4) and NOT a registry — make the single StructDecl/layout-descriptor the generator from which the WGSL string AND the CPU offset constants AND the worker field set are derived. Converts a serializing+drift-prone contract into a single-edit one.

## 3. Ordered roadmap (cheapest-highest-leverage first)

### Tier A — registry splits of the emission authorities (append-only, the proven mechanic)
- **A1. spec-coverage** ✔ landed (`36ca51c7`). Gate: set-identical.
- **A2. `paint.ts` → paint-fill/line/fill-extrusion/raster + dispatcher** (row 6). Gate: **byte-identical emitted utility-string set** over the demo+OFM corpus (the runtime lexer contract is the string set). Risk: low.
- **A3. `expressions.ts` → per-cluster handler registry** (row 7). Gate: byte-identical xgis-expression emission + a deep-nest fixture still throws at the same depth (`_exprDepth` central). Risk: low-med.
- **A4. `layers.ts` convertLayer → Map registry** (row 20) + **barrels** (row 24). Gate: set-identical exports / identical converter output. Risk: trivial.
- **A5. matrix.manifest + demos.ts per-category fragments** (rows 9, 10). Gate: set-identical cell-ids / demo-keys + a CI uniqueness check. Risk: trivial.

*Tier A is mutually independent → the worktree fan-out candidates (§5).*

- **A6 (SEPARATE — behavior-changing, NOT faithfulness-preserving). monaco ← LANGUAGE_SCHEMA** (row 21, Move 2). Gate: the derived keyword/property/function sets ⊇ the current arrays, pinned by a schema-equality test. **This intentionally changes behavior** (adds missing keywords / removes drift) — do NOT lump into the "set-identical" framing of A1–A5. *(critic F7)*

### Tier B — contract-first IR spine (the keystone; ONE sequential commit before any Tier-C fan-out)
- **B1. Sub-bundle the shape *bundles*** (row 15): PaintShapes → Fill/Line/CircleShapes; LabelShapes likewise. Keep `PropertyShape<T>` shared. Gate: type-only — `bun run build` typecheck + full vitest + one render smoke; assembled bundle structurally identical. Risk: med (25+ importers).
- **B2. Sub-bundle `ShowCommand`/`RenderNode` + composable emitters** (rows 3, 5). Replace the emitShow 43-field literal with `emitFillFields…` → `Partial<ShowCommand>`. **Gate: byte-identical emitted IR over the corpus is the SOLE sufficient gate.** The TS exhaustiveness switch is necessary-but-**insufficient** — emitShow carries lossy scalar fallbacks (`?:1`, `?:1.0`, `?:0`, `?:null`) that compile clean if dropped/reordered; only IR serialization catches them. *(critic F2, load-bearing)* Risk: med (coordinated 3-party contract, but faithful sub-bundling is byte-stable).
- **B3. `GPUTile` → base + per-type slices** (row 8) + **`RenderLoopHost` → per-pass role interfaces** (row 19). Gate: type-only (host) / presence-identical (slice) + render smoke + the `__vertex-format-crosscheck` contract test green. **Hard constraint: dequantScale/Half + slice offsets stay co-located with producer/consumer** (§4). Risk: med / low.
- **B4. Table-drive the resolveShow cache enumeration IN PLACE** (row 16). **Gate: pin per-frame cache HIT/MISS decisions, not only resolved values** — a per-frame allocation-count + hit/miss assertion. **Do NOT add the zoom-only `fillTranslateX/Y`, `strokeTranslateX/Y`, `dashArray` axes to the hit-check** — they deliberately rely on the zoom-keyed cache shortcut (`resolved-show.ts:140-158`); mechanically enumerating "every cached shape" would change hit-rate = silent perf regression that "identical resolved output" will NOT catch. *(critic F1, load-bearing)* Risk: med (hot path).

*After B2/B3, adding one paint property stops being a lock-step edit across 3–4 files → one descriptor + one sub-bundle field. The throughput unlock.*

### Tier C — god-file decomposition behind the Tier-B contracts (highest cost, incremental)
- **C1. `lower.ts` lowerLayer → BindingHandler registry** (row 2). **Hard dependency edge: B2 → C1** — the BindingHandler outputs must target the post-B2 sub-bundled ShowCommand shape, else C1 is rewritten twice. *(critic, sequencing)* **Gate: assert the X-GIS0005 diagnostic set is unchanged/empty over the corpus** (the catch-all emits a diagnostic, so a dropped handler is mechanically detectable, not silent) + byte-identical IR + apply-order test (named→inline→utilities; stroke data-driven>zoom>constant). *(critic F3)* Risk: med-high.
- **C2. VTR `renderTileKeys` → per-pass strategy + per-layer-type uploader** (rows 1, 14). After C1; **must NOT overlap M5** (both touch the VTR `f32`-index region) → serialize C2 after M5's polygon-uniform half. Gate: **real-GPU pixel-diff per CLAUDE.md §5** (DC>0 on the intended pass, D1<D0 vs ML, 16-split read across the style matrix); OIT/depth ordering + arena slice-offset binding byte-identical (do NOT touch the `recordTileFill` inner loop). Risk: **high**.
- **C3. `map.ts` rebuildLayers → LayerBuilder registry + owner-objects** (row 4). Gate: identical layerId register ORDER (pick-id stability) + render smoke per layer kind. Risk: med-high.
- **C4. text-stage prepare() + label-pass execute() → per-concern passes** (row 13). Can run concurrent with C2/C3 (disjoint files); its halves are internally sequential (shared collision-order invariant). Gate: real-GPU label parity (point-dedup #458 higher-symbol-wins + curved + collision order preserved). Risk: med-high.
- **C5. tiler / tile-catalog / parser / mapbox-to-xgis / editor / demo-runner per-concern splits** (rows 11, 17, 18, 12, 25). Gate: byte-identical tile vertex output (keep ecef-packing shared) / set-identical warnings order / parser snapshots / editor undo-snapshot semantics. Risk: med, clean seams.

### Move-5 (parallel to Tier B, do early to kill the drift class)
- **M5. Derive CPU offsets + worker field set from the single StructDecl.** `polygon.ts` Uniforms → `line.ts` mirror + VTR `f32`-index writes; the tile-layout descriptor → `mvt-worker.ts`. **NB (critic F5): `TILE_LAYOUT_VERSION` lives in `tile-catalog.ts` + `sources/*`, NOT `tile-source.ts` (only `BackendTileResult` is there) — re-verify the two M5 halves are file-disjoint before parallelizing them.** Gate: byte-identical generated WGSL + byte-identical CPU offset table vs current constants (the test IS the contract); bump TILE_LAYOUT_VERSION + re-bake goldens on any real change. Risk: med — touches the worst bug class but the gate is exhaustive (byte-equality) and it *removes* a recurring failure mode.

## 4. DO NOT SPLIT — the shared correctness seams

The CPU↔WGSL agreement archetype + hot per-frame loops. Sharding these re-introduces the repo's worst bug class (#360 tail degrees-vs-Merc, #392 fill-vs-outline, #398). Edits here are *deliberately serialized*; the mitigation is **Move 5 (derive the mirror), never a split**.

- **`compiler/src/tiler/polygon-vertex-format.ts` POLYGON_FILL/EXTRUDED_FORMAT** — the single-authority vertex layout the packer + WGSL `@location` inputs + host `GPUVertexBufferLayout` all derive from. Bump TILE_LAYOUT_VERSION + re-bake goldens on change.
- **`shaders/polygon.ts` Uniforms (256B) + `line.ts` TileUniforms mirror + raw f32-index writes in VTR** — one byte agreement across three sites; pad fields hold the 256B alignment. (Move 5.)
- **`compiler/src/ir/property-types.ts` PropertyShape<T>** — the eval-shape union; CPU resolve + WGSL palette/compute codegen + worker bake all switch on `kind`. A new `kind` is a coordinated CPU↔shader edit. (Only its bundles split — row 15.)
- **`runtime/src/data/tile-source.ts` BackendTileResult** (+ `dequantScale`/`dequantHalf` co-located) mirrored by `mvt-worker.ts` MvtWorkerResult — the produce→cache→upload byte contract. (Move 5.)
- **`GPUTile` slice offsets + dequant fields** consumed byte-for-byte in `recordTileFill` + the WGSL dequant decode — stay co-located with producer/consumer even after the GPUTile *type* sub-bundles.
- **`shaders/projections.ts` proj_params.x ladder + t<n.5 thresholds + `project_geom`/`project_geom_cpu` pair**, agreeing with `projections-table.ts` row order (index == projType) + `projection.ts` MERCATOR_LAT_LIMIT — pinned by projection-threshold/wgsl-consistency tests.
- **`projections-table.ts` name + projType + cullThreshold columns** (WGSL-read). Only the function-wrapped CPU-only columns (`worldBand`/`worldCopies`/`poleLimit`) lift out (verified already accessor-wrapped — safe).
- **Hot loops:** resolveShow alloc-free cache (one cache, table-drive in place); gpu-tile-store arena alloc/free (split only eviction *thresholds*); tile-select/tiles-sse DFS/SSE driver + MVP math; globe.ts SoA traversal; VTR pipeline-variant/depth-stencil ordering.
- **`colors.ts` colorToXgis** — single parse/emit authority.
- **`shared/src/index.ts` / `blueprint/src/index.ts` barrels** — correctly-sized contract boundaries; leave shared.

Model to copy (already healthy): `__vertex-format-crosscheck.ts` + `vertex-layout-consistency.test.ts`. Every Move-5 increment ships one.

## 5. Parallel execution plan (worktree fan-out vs sequential spine)

Following "scaffold-once → worktree fan-out → integrate-once":

**Concurrent worktree agents (separable, no shared spine):**
- **All of Tier A (A2–A5)** — each touches its own descriptor/fragment file; append-only splits, the whole point is they don't conflict. One executor per increment in `isolation:"worktree"`. Only shared conflicts: arch-ratchet `LOC_CEILINGS` + gap-matrix regen → resolve in the **integration pass, not per-worktree**.
- **M5's two halves** — IF re-verified file-disjoint (F5) — as two concurrent agents, each shipping its own contract test.
- **Tier C's independent splits** (C5: tiler, parser, mapbox-to-xgis, tile-catalog, editor, demo-runner) — disjoint files, after the contracts.

**Sequential (shared spine / scaffold dependency):**
- **Tier B is a single sequential spine commit BEFORE any Tier-C renderer fan-out** (the WS-1 lesson — each axis re-touching the spine is what serialized them). B1→B2→B3 mutate the shared ShowCommand/RenderNode/GPUTile/Host contracts; concurrent edits to these ARE the conflict.
- **B2 → C1** hard edge; **C1 → C2**; **C2 after M5** (shared VTR f32 region). **C4** concurrent with C2/C3 (disjoint) but internally sequential (collision order).

**Net cadence:** ~5 Tier-A agents + (≤2 M5 agents) in parallel first → one sequential Tier-B scaffold commit → fan out Tier-C god-file splits in worktrees behind the contracts, serializing only the three on the VTR/lower/map.ts hot spine. Per-change gate = targeted faithfulness check (~1s set/byte-diff); full suite + real-GPU pixel-diff matrix run **once per integration barrier**.

**Implementer key files:** scaffold doc `2026-06-20-parallel-axis-architecture.md`; proven templates `runtime/src/capabilities/*` (`47a78247`), `compiler/src/convert/spec-coverage/*` (`36ca51c7`); contract-test model `__vertex-format-crosscheck.ts` + `vertex-layout-consistency.test.ts`; must-stay-shared authorities `polygon-vertex-format.ts`, `tile-source.ts`, `projections-table.ts`, `property-types.ts`.
