# Design Proposal — runtime/src layered decomposition (corrected after adversarial review)

> **STATUS: DESIGN PROPOSAL — NOT YET IMPLEMENTED.**
> This revision fixes the five **blocking** layering/migration defects and the three
> **cargo-cult** risks found in adversarial review. The half the review judged
> shippable — the god-file split _units_, the DO-NOT-SPLIT cohesion zones, the four
> ratchet gates, the Gate-4 projType allowlist, the `projections-table` SoT + the
> `gpu-shared` re-export, and the incremental Wave structure — is preserved verbatim.
> The half the review judged _aspirational_ — the strict numbered L0–L5 "downward-only"
> spine, the `eval → style` promotion that inverted render↔style, the optional `math/`
> rename, and the `paint-interp.ts` new leaf — is reworked to be **consistent with the
> actual import graph** before any boundary lint is proposed.
>
> Every "X imports Y" claim below was re-verified against the working tree at the cited
> `file:line`. Where the prior draft cited MODULES.md LOCs (VTR 5608 / map 2956), this
> revision uses the **enforced** `LOC_CEILINGS` figures (the gate that actually fails CI)
> and flags MODULES.md as stale rather than depending on it.

---

## 0. What changed vs the reviewed draft (the correction log)

The reviewer's verdict was blunt and correct: _"Not approvable until the spine is made
consistent with the actual import graph."_ The flagship principle (a numbered,
downward-only layer spine) was **not satisfiable as a rename-only move** — the single
most load-bearing L0 file (`projection/camera.ts`) already imports across the proposed
L1/L2/L4, and the `eval → style` move **inverted** the render↔style call direction. This
revision takes the reviewer's recommended path **(a): demote the strict L0 to a layer
charter the real graph already obeys, and renumber** — _plus_ it records path **(b)**
(physically hoist the shared constants/fragments to sever the edges) as a clearly-scoped,
**optional** later refactor rather than a precondition smuggled into a "relocate".

| #   | Review defect                                                                                                                                                                                           | Correction in this revision                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | `camera.ts` imports L1 (`gpu`, `gpu-shared`), L2 (`shaders/log-depth`), L4 (`loader/geojson`) — 4 upward edges vs the L0 charter; never reconciled in §3.                                               | §2 redefines L0 (now **L0 `coords+camera`**) so the charter **permits** reading platform _constants_ and pure _shader fragments_; the one genuinely cross-layer edge — `lonLatToMercator` from `loader/` — is named in §3.1 and §4 as the **single edge the lint flags**, with a 1-function fix (move the pure converter down to L0). No charter is asserted that the file violates.                                                                                     |
| B2  | `globe.ts:22` & `view-matrix.ts:20` import `WORLD_MERC`/`TILE_PX` from L1 `gpu-shared` — undocumented L0→L1 upward edges; migration never relocates these constants.                                    | §2 reclassifies `WORLD_MERC`/`TILE_PX` as **L0 coordinate constants that merely _live_ in `gpu-shared` today**. They are read by L0 projection math (`globe`, `view-matrix`, `camera`) and are coordinate-space facts, not platform facts. Optional refactor R-A (§5) physically moves them into `coords/` so the edge disappears; until then the lint **allowlists** these three reads explicitly.                                                                      |
| B3  | `data/eval/* → style/` move makes L3 render (`VTR:39`, `label-pass:25`) depend UPWARD on L4 style — inverts the spine.                                                                                  | **The `eval → style` promotion is dropped.** `data/eval/` stays an internal `data/` subdir (a leaf consumed by render), so render→eval stays **downward**. The taxonomy no longer has a `style/` tier sitting above render; style/paint resolution that render consumes is a **lower** leaf, never above it. (§2 spine, §3.5.)                                                                                                                                           |
| B4  | `log-depth` placed at L2 but consumed by L0 `camera.ts` → forced L0→L2 edge; it imports nothing.                                                                                                        | `log-depth.ts` is reclassified **L0** (it imports nothing; §2). `camera.ts:7` reading `computeLogDepthFc` is now a legal **intra-L0** edge. The shader _variants_ (polygon/line/…) stay higher; only the pure CPU+WGSL-shared _fragment_ drops to L0.                                                                                                                                                                                                                    |
| B5  | `paint-interp.ts` (NEW leaf) presented as a "hard prerequisite"; the interpolators already live in `renderer-helpers.ts:84+`. The cycle is `paint-shape-resolve.ts:25` importing them via `./renderer`. | **`paint-interp.ts` is deleted from the plan.** The renderer↔paint-shape-resolve cycle is broken by **retargeting one import**: `paint-shape-resolve.ts:25` from `'./renderer'` to `'./renderer-helpers'` (the file that actually defines `interpolateZoom`/`interpolateZoomRgba`/`interpolateTime`/`interpolateTimeColor`). One line, zero new files. (§3.4, §4 Wave 0.)                                                                                                |
| C1  | `style/` as a distinct top-level tree — philosophy-driven; `data/eval` has only 3 external consumers and unmeasured `filter-eval↔tile-catalog` coupling.                                                | Dropped (see B3). `data/eval/` remains where it is. The three external consumers are confirmed (`show-source-maps.ts:16`, `render/passes/label-pass.ts:25`, `render/vector-tile-renderer.ts:39`); no new tree is justified by FHS aesthetics.                                                                                                                                                                                                                            |
| C2  | `math/` unified rename of `projection/`+`core/` is "optional" and rewrites many imports for no enforced invariant.                                                                                      | The **rename is dropped as a goal**. §2 states explicitly: _the load-bearing artifact is the **layer charter + the lint that enforces direction**, not a directory rename._ Existing `projection/` and `shared/` stay put; the layer is a _logical_ tier the lint checks, costing zero import-line churn.                                                                                                                                                                |
| C3  | The strict L0 lint would immediately flag camera/globe/view-matrix/VTR/label-pass → lint can only ship "warn-only with a large baseline" → taxonomy aspirational not enforced.                          | §4 **Wave 0** is honest about this: the boundary lint ships **enforcing only the edges the graph already satisfies** (the four existing ratchet gates + the _downward_ render→eval / camera→coords directions), and **allowlists** the named residual upward reads (camera→loader, globe/view-matrix→gpu-shared constants) with a TODO pointing at optional refactors R-A/R-B (§5). It is **enforcing-with-a-named-allowlist**, not "warn-only with a mystery baseline". |

Everything below incorporates these corrections. Sections the review affirmed as sound
are unchanged in substance.

---

## 1. Why — the debt this acts on

[MODULES.md §4](docs/architecture/MODULES.md) names the engine's largest classes as the
**#1 architectural debt: unclear state-ownership**. **MODULES.md is stale** (it still lists
VTR 5608 / map 2956 and calls the decomposition "unexecuted"); the _enforced_ sizes are the
high-water marks pinned in `runtime/src/engine/architecture-invariants.test.ts`
(`LOC_CEILINGS`, measured 2026-06-09, shrink-only). Both the staleness and the live ceilings
were re-verified:

| Unit               | File                                                | LOC (enforced ceiling) |
| ------------------ | --------------------------------------------------- | ---------------------- |
| VectorTileRenderer | `runtime/src/engine/render/vector-tile-renderer.ts` | 3962                   |
| XGISMap            | `runtime/src/engine/map.ts`                         | 3494                   |
| MapRenderer        | `runtime/src/engine/render/renderer.ts`             | 915                    |
| TextStage          | `runtime/src/engine/text/text-stage.ts`             | 1465                   |
| TileCatalog        | `runtime/src/data/tile-catalog.ts`                  | 1415                   |
| Camera             | `runtime/src/engine/projection/camera.ts`           | 1114                   |
| label-pass         | `runtime/src/engine/render/passes/label-pass.ts`    | 1119                   |
| compiler lower     | `compiler/src/ir/lower.ts`                          | 1348                   |

> **Correction note (vs reviewed draft):** the prior draft asserted "all 13 god-file LOCs
> match `wc -l`" using MODULES.md's 5608/2956. Those are the **stale** numbers. The numbers
> above are the ones CI actually fails on. The decomposition _units_ the review affirmed are
> unchanged; only the LOC citations are corrected to the enforced source of truth.

### The ownership principle (kept — review affirmed)

> Kill god-objects by extracting **ownership**, not code. A god class = unclear
> state-ownership; the fix is to define _who owns each piece of state_, give it a narrow
> interface, and let the former god class shrink to a thin coordinator that wires the owners
> and holds only the order.

LOC reduction is a _consequence_ of moving ownership, applied as a "grandfather + shrink-only"
ratchet (`LOC_CEILINGS`), never the goal. A blind ≤500-line chase _hurts_: it splits hot loops
and the intentionally-cohesive uniform layout (§3 DO-NOT-SPLIT).

### The working precedent (kept — review affirmed)

- **Orchestration lifts out cleanly.** Render passes were extracted from `XGISMap.renderFrame`
  into a stateless `RenderLoop` + `render/passes/*` reaching renderers through a typed
  `host: RenderLoopHost` view.
- **Owned state lifts out cleanly.** Inside VTR, `UniformRing` and `PrefetchScheduler` are
  _already_ extracted owners with narrow interfaces, each receiving caller-side policy via a
  callback. The byte _layout_ stayed with VTR; only the _buffer lifecycle_ moved.

This proposal **finishes an architecture already in motion** — same composition pattern,
remaining clusters.

---

## 2. The layer charter — corrected to match the real import graph

> **What is load-bearing here:** the _direction rule_ and the _lint that enforces it_ — **not**
> a directory rename. No file is renamed by adopting this charter. Each "layer" is a logical
> tier the lint checks; existing `projection/`, `shared/`, `gpu/`, `render/`, `data/`, `text/`
> directories stay exactly where they are. (This is the C2 correction: the `math/` rename is
> dropped; the layer, not the rename, is the asset.)

### 2.1 The renumbered, satisfiable spine

The reviewed draft's spine was _L0 math → L1 gpu/platform → L2 shader → L3 render → L4
io/style → L5 facade_ with "arrows downward only". That spine was **not satisfiable**:
`camera.ts` (deepest, most-imported node) reaches L1/L2/L4, and render imports `data/eval`
(which the draft moved above render). The corrected spine is built **from the graph that
exists**, so the rule it states is the rule the lint can actually enforce:

```
L0  coords + camera + pure fragments
      projection/ (projections-table SoT, mercator, globe, ecef, view-matrix, camera,
      camera-helpers, unproject), shaders/log-depth (imports nothing),
      shared/ types + ecef, and the coordinate CONSTANTS WORLD_MERC/TILE_PX
      (today physically in gpu-shared; logically L0 — see R-A).
        charter: may import only L0. MAY read platform CONSTANTS and pure CPU/WGSL
        shader FRAGMENTS. MUST NOT import a GPUDevice-bound module, render, data, or facade.

L1  gpu / platform
      gpu/ (device, buffer-pool, uniform-ring, dpr/quality), gpu-shared (which
      DOWNWARD re-exports L0 projections-table predicates — the one legal cross edge),
      shader VARIANTS (polygon/line/point/raster/icon/text emit).
        charter: imports L0 + L1. The gpu-shared→projections-table re-export is L1→L0
        (downward, legal). gpu-shared also HOLDS the L0 coord constants until R-A.

L2  data / io  (NOTE: BELOW render — see 2.2)
      data/ (tile-catalog, tiles, sources, workers, eval/ — filter-eval/computeSliceKey,
      slice keying, color-ramp/paint resolution that render CONSUMES), loader/ (fetch/decode).
        charter: imports L0–L1. A LEAF that render reads; never imports render or facade.

L3  render
      render/ (vector-tile-renderer, renderer, render-loop, passes/*, point/raster
      renderers), text/ (text-stage + label layout/collision).
        charter: imports L0–L2 DOWNWARD. render→data/eval (computeSliceKey) is L3→L2,
        downward, legal. render must NOT import facade.

L4  facade
      map.ts (XGISMap), interaction controllers, diagnostics accessors.
        charter: imports L0–L3. The top; nothing imports it (Gate 2 keeps render-loop's
        ./map edge type-only).
```

**Rule (lint-enforceable):** an import may target the same layer or a **lower** layer. The
two intentional exceptions are named, not hidden: (i) `gpu-shared` (L1) **re-exports** L0
`projections-table` predicates — a _downward_ L1→L0 read, `gpu-shared.ts:303-309`, verified;
(ii) `render-loop.ts` imports `./map` (L4) **type-only**, erased by tsc — pinned by Gate 2
(`architecture-invariants.test.ts:64-76`), verified.

### 2.2 Why `data`/`eval` is BELOW render, not above (the B3/C1 fix)

The reviewed draft placed a `style/` tier (containing `data/eval/*`) **above** L3 render, then
claimed style is _"consumed by render … never the reverse."_ That is internally contradictory:
**render is the consumer**, so the consumed thing sits **below** the consumer. The real edges
confirm render→eval is the call direction:

- `render/vector-tile-renderer.ts:39` → `import { computeSliceKey } from '../../data/eval/filter-eval'`
- `render/passes/label-pass.ts:25` → `import { computeSliceKey } from '../../../data/eval/filter-eval'`
- `engine/show-source-maps.ts:16` → `import { computeSliceKey } from '../data/eval/filter-eval'`

`computeSliceKey` is _defined_ at `data/eval/filter-eval.ts:186`; its other consumers
(`data/workers/mvt-worker.ts`, `data/sources/pmtiles-backend.ts`) are **internal to `data/`**.
So `data/eval/` is a clean **leaf** that L3 render reads downward. Promoting it to a tier
above render would invert exactly this edge. Therefore: **`data/eval/` stays put** as an
internal `data/` subdir; no `style/` top-level tree is created (C1). Any paint/color
resolution render consumes (`color-ramp`, paint-shape resolution) is likewise an L2/L3 _leaf
below or beside render_, never a layer above it.

### 2.3 The residual upward edges — named, not denied (the B1/B2/B4/C3 fix)

Re-verified imports of the deepest node, `projection/camera.ts`:

| `camera.ts` line | import                                          | layer of target             | status under corrected charter                                                                                                                                                                                |
| ---------------- | ----------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:3`             | `lonLatToMercator` from `../../loader/geojson`  | L2 (data/io)                | **The one true violation.** A pure coord converter living in the loader. Fixed by R-B (move the converter down to L0 `projection/mercator`), ~1 function. Until then: **lint allowlist entry** with TODO→R-B. |
| `:5`             | `WORLD_MERC, TILE_PX` from `../gpu/gpu-shared`  | L0 constants (housed in L1) | **Legal-by-reclassification.** Coordinate constants are L0 facts; they merely _live_ in gpu-shared today. R-A moves them to `coords/`; until then allowlisted. Same for `globe.ts:22`, `view-matrix.ts:20`.   |
| `:6`             | `getMaxDpr` from `../gpu/gpu`                   | L1 platform                 | **Genuine L0→L1 read of a device-capability scalar.** Either (a) inject DPR into the camera as a number from L4 (preferred, kills the edge), or (b) allowlist with TODO→R-C. Named, not hidden.               |
| `:7`             | `computeLogDepthFc` from `../shaders/log-depth` | **L0** (reclassified, B4)   | **Legal intra-L0.** `log-depth.ts` imports nothing; it is a pure fragment, not a shader variant.                                                                                                              |

So the corrected charter is satisfied by all of L0 _except_ two named, allowlisted reads
(camera→loader converter, camera→`getMaxDpr`) and the three coord-constant reads
(camera/globe/view-matrix → `gpu-shared` WORLD_MERC/TILE_PX). **That is the honest state of the
lint (C3):** it enforces every edge the graph already satisfies and carries a _small, named_
allowlist with each entry pointing at the optional refactor that retires it — not a "warn-only
with a large opaque baseline" that silently legitimizes drift.

---

## 3. The decomposition units (review affirmed this half — substance unchanged)

> The reviewer: _"the decomposition realism problem is NOT in the splits — it is in the
> TAXONOMY layering."_ The taxonomy is fixed above. The split units below — low-blast
> state/diagnostics clusters, ordered lowest-risk-first, with every hot loop and slot-reader
> fenced — are kept as-is.

### Shared method (kept)

- **Step A — extract by STATE OWNERSHIP into narrow-interface owners.** Group private fields by
  the cluster that mutates them; each cluster becomes the **sole writer**, exposing verbs.
- **Step B — the class becomes a thin coordinator.** Keeps external refs, per-frame _order_,
  the per-frame paint scalars stamped into uniforms, and the public entry signatures (the
  byte-stable **contract boundary**). Holds one of each owner and wires them.
- **Step C — behavior-preserving, every cut verified by an existing gate** (§ verification).

### DO-NOT-SPLIT zones (kept — review: "correctly fenced … realistic")

1. **Hot loops.** VTR's per-tile `renderTileKeys` loop and TextStage's `prepare()` shaping loop
   read across _all_ clusters by design — they _become_ the thin coordinator. Owners are
   _received as collaborators_; the loop body stays one method.
2. **Uniform byte layout / vertex-format slot contract.** The per-tile pack writes fixed float
   offsets the WGSL struct reads by position ([ADR-0001](docs/adr/0001-ecef-tile-pipeline.md));
   out-of-bounds typed-array writes are silent no-ops. The **producer↔consumer slot contract**
   (the #360 tail degrees-vs-local-Merc and #392 fill-vs-outline bugs) stays welded; any
   `UniformPacker` extraction **carries its slot constants and re-pins
   `__vertex-format-crosscheck.ts`**. The byte-drift gate pins it.
3. **Draw order.** Opaque → OIT → translucent-strokes → points → labels is fixed for alpha
   compositing; within opaque, 2D-fills-then-3D-extruded is load-bearing. Decomposition invokes
   owners _within_ the order; never reorders.
4. **Text hot pipeline.** `text-stage → collision → label-pass` is a hot pipeline with an
   ordering contract (`TextStage.prepare` MUST run before `IconStage.prepare`, enforced in
   `label-pass.ts`). Frame-lifetime `_frameArena` views are live-borrowed into `TextDraw`; the
   copy-on-store seam (`new Float32Array(view)`) must survive any owner boundary.
5. **Arena byte-aware eviction (#410).** `gpu-tile-store` byte-aware eviction with its
   hand-maintained accumulators (`_cachedBytes`, `_gpuCacheCount`) moves **wholesale** with its
   backing collection, or it desyncs (TileCatalog already shipped a 263 MB false-eviction drift
   from exactly this, commit `497a2c1`).

### 3.1 VectorTileRenderer (3962 LOC) — the #1 pilot

**Proposed owners.** `GpuTileStore` (cache + arenas + byte-aware eviction #410 — carries
slot/byte accounting wholesale), `TileUploader` (queue + encode), `UniformRing` (exists),
`BindGroupRegistry` (bind groups + pipeline registry), `FeatureDataBinder` (compute paint),
`TileSelectionCache` (visible-set memo + hysteresis), `LabelFeatureSource` (CPU label
iteration), `FrameDrawStats` (diagnostics). Coordinator keeps
`render`/`renderTileKeys`/`recordTileFill`/`beginFrame`/`endFrame` + paint scalars.

**Layer note.** VTR is L3 render. Its `computeSliceKey` import (`:39`) is L3→L2 **downward**
(corrected charter §2.2) — _not_ a violation. The only edge the lint flags here is the
transitive one through `camera` (L0→loader), addressed by R-B.

**Cleanest-first cut + gate.** `LabelFeatureSource` (the `forEach*Label*` family +
`_lineLabelRunsCache` + `_frameArena`): touches only `source.getPropertyTable()` + `stableKeys`

- `_frameTileCache.neededKeys`, **zero GPU state**. Verified by `_label-anchor-parity` +
  `_projection-label-onscreen` + `merc-high-pitch-drag-perf.test.ts`.

**Risk: high. Value: high.** The **DO-NOT-EXTRACT** row: the `render()` ~2k-LOC hot loop + its
`doUploadTile` twin — do not distribute the hot-loop body across FillDraw/LineDraw owners (fill
and line are coupled by `slotOffset` + `strokeQueue` + the single end-of-loop
`flushUniformStaging`). The GPU-memory triad (`GpuTileStore` + `TileUploader`) ships **last and
alone** with the warm-harness numeric perf comparison + the screenshot-eyeball loop.

### 3.2 XGISMap (`map.ts`, 3494 LOC) — public-API facade + wiring hub (L4)

**Already mid-decomposition** (`CameraController`, `SourceManager`, `InteractionController`,
`EventDispatcher`, `RenderLoop` are extracted collaborators receiving state Maps by reference).

**Proposed owners (the genuine state/diagnostics clusters — review affirmed low-blast):**
`SceneBuilder` (the `rebuildLayers` body), `MapLifecycle` (mount/teardown + GPU init),
`StyleCompatApi` (runtime mutation — Mapbox-parity setters), `FeatureUpdateQueue`
(external-injection coalescing), `CameraApi` (the ~25 thin camera delegates),
`DiagnosticsApi` (pure forwarders). XGISMap stays the thin facade holding the canonical
state Maps.

**Cleanest-first cut + gate.** `FeatureUpdateQueue` (`updateFeature`/`flushPendingUpdates`/
`scheduleFlushPendingUpdates` + its 4 state fields). CPU-only → fully covered by the no-GPU
CI lane (vitest characterization + polygon-variant byte-drift + pixel-match).

**Ordering.** `rebuildLayers`/`setQuality`/`_installSyntheticEarthSurfaceSource` each repeat an
identical ~8-call VTR setter ritual 3×; **do the VTR setter-collapse first**
(`configureFromRenderer(renderer)` on VTR), _then_ `SceneBuilder` lifts cleanly.

**Shared-state hazards (kept):** synthetic-earth-surface bg is three-way cross-owned
([ADR-0005](docs/adr/0005-synthetic-earth-surface-background.md)); `vtSources` has concurrent
writers (rebuild + teardown + async compile); the `setQuality` invariant
(`entry.pipelines===null ↔ entry.layout===null`) straddles two methods; `rebuildLayers` is
re-entrant → `SceneBuilder` must be stateless-re-callable.

### 3.3 TextStage (`text-stage.ts`, 1465 LOC) — label pipeline (L3)

**Proposed owners.** `TextShaper` (point+curved per-label layout math — pure;
`wrapWithKnuthPlass` + `mlVerticalLayout`), `LabelLayoutCache`, `WrapCache` (promote the
module-global `_pretextCache` to injected state — fixes latent multi-instance aliasing),
`AtlasAdmissionController` (the stable-atlas invariant), `LabelCollisionResolver`
(precedence + `droppedPairKeys`), `TextDiagnostics`/`LabelDiagnostics` (pure sink).

**Cleanest-first cut + gate.** `TextShaper` — consumes immutable inputs, produces a value
(`TextDraw` + bbox). Wrap + vertical are already test-seamed
(`text-wrap.test.ts`/`text-vertical.test.ts`/`text-layout-edge.test.ts`). **CAVEAT —
characterization tests first:** `prepare()` has no direct unit test; write characterization
tests (layout-cache hit, overflow-drop, collision-precedence) before cutting.

**Coupling.** To IconStage via `droppedPairKeys` (order contract enforced in `label-pass.ts`).
**No coupling to the other god-objects' state** → a good standalone pilot.

### 3.4 MapRenderer (`renderer.ts`, 915 LOC) — pipeline factory + the renderer↔paint cycle (L3)

**Proposed owners.** `PolygonPipelineFactory` (the pipeline fields + `shaderCache` + variant
builders + static layout entries — highest value), `UniformRingHost`, `PaletteAtlasState`,
`ComputePaintRegistry`, `GraticuleOverlay` (self-contained, default-off), `BackendRegistry`
(deprecate-and-confirm-dead arm).

**The renderer↔paint-shape-resolve cycle — corrected (B5).** The reviewed draft proposed a NEW
`paint-interp.ts` leaf as a "hard prerequisite". **It is unnecessary.** The interpolators
(`interpolateZoom`, `interpolateZoomRgba`, `interpolateTime`, `interpolateTimeColor`) **already
live** in `render/renderer-helpers.ts:84+` and are merely re-exported by `renderer.ts`. The
cycle exists _only_ because `render/paint-shape-resolve.ts:25` imports them via `'./renderer'`
instead of the leaf that defines them. **Fix: one line** —

```
- import { interpolateZoom, interpolateZoomRgba, interpolateTime, interpolateTimeColor } from './renderer'
+ import { interpolateZoom, interpolateZoomRgba, interpolateTime, interpolateTimeColor } from './renderer-helpers'
```

No new file. This lands in Wave 0 (it is a pure import retarget; `renderer-helpers.ts` already
exports all four — verified). Creating `paint-interp.ts` would be cosmetic churn.

**Cleanest-first cut + gate.** Prove the mechanism on `GraticuleOverlay` (cheap, isolated, ~70
LOC, default-off), then spend real effort on `PolygonPipelineFactory`, gated by the
**polygon-variant byte-drift snapshot** + the SwiftShader `_wgsl-compile-gate` + the
bind-group-drift invariant test that reads the static layout entries _without a GPUDevice_.

**Shared-state hazard (kept):** bind-group co-ownership — `rebuildUniformBindGroups` +
`setPaletteColorAtlas` + `setSpriteAtlas` reconstruct the _same_ immutable `GPUBindGroup` from
three owners' state; the honest resolution is a small shared `BindGroupAssembler` all three
call, OR the facade keeps `rebuildUniformBindGroups` as the coordination point.

### 3.5 TileCatalog (`tile-catalog.ts`, 1415 LOC) — tile router + cache + budget (L2)

**Layer note.** TileCatalog is L2 (data). `data/eval/filter-eval` lives beside it in `data/`;
the doc does **not** claim to have measured a `filter-eval↔tile-catalog` coupling, so no move
that depends on that coupling is proposed (Open-Q2). Both stay internal to `data/`.

**Proposed owners.** `TileDataCache` (`dataCache` + `_cachedBytes` + `sizeOfTileData` —
**extract FIRST**, everything writes `_cachedBytes`), `BackendRegistry`, `LoadTracker`
(tiny, clean), `FrameBudget`, `PrefetchScheduler` (the messy owner — its protection sets are
read by eviction).

**Cleanest-first cut + gate.** `LoadTracker` (`loadingTiles`): mutated only via sink hooks + the
`requestTiles` gate. Verified by `tile-catalog-multi-backend.test.ts` + `getTileState`. CPU-only
→ no-GPU CI.

**Shared-state hazards (kept):** eviction is a three-way decision (PrefetchScheduler protection
sets + TileDataCache `dataCache`/`_cachedBytes` + VTR-passed `protectedKeys`) → stays
coordinator-orchestrated; `setSlice`/`deleteCacheEntry`/`_cachedBytes` stay welded with
`assertByteAccountingInvariant` (the 497a2c1 drift). **Ordering: sequence with VTR** (shared
`onTileLoaded` + per-frame-pump contract).

### 3.6 Camera (`camera.ts`, 1114 LOC) — view/projection matrices (L0)

**Proposed owners.** `ViewMatrixBuilder` (derived matrices + caches — reads state by reference;
already partly extracted to `view-matrix.ts`), `CameraController` (gesture→state writes — the
hazardous cluster), `Unprojector` (screen→world; already extracted to `unproject.ts`),
`CameraState` (the irreducible mutable core both reference). Because `Camera` is passed by
reference everywhere, the coordinator keeps the `Camera` class as state+facade and delegates
one-to-one, preserving every call site byte-for-byte.

**Layer note (the B1 fix in practice).** Camera is L0. Under the corrected charter its imports
are legal **except** two named, allowlisted reads — `lonLatToMercator` from `loader/` (`:3`,
fixed by R-B) and `getMaxDpr` from `gpu/gpu` (`:6`, fixed by R-C/injection). The
`computeLogDepthFc` (`:7`) and `WORLD_MERC`/`TILE_PX` (`:5`) reads are legal-by-reclassification
(§2.3). These are the precise edges Wave-0 lint flags-with-allowlist, not silent baseline.

**Cleanest-first cut + gate.** Extract the `Unprojector` cluster FIRST (already in
`unproject.ts`): it is the single dependency shared by _both_ future owners and is
pure-functional. Verified by `ortho-unproject-parity.test.ts` + `camera-z0-probe.test.ts` +
`visible-world-copies.test.ts` + `interaction-contract-gates.test.ts` + `camera.test.ts`. Mostly
CPU/compute → strong CI.

**Shared-state hazards (kept):** builder↔controller is a bidirectional edge, not a DAG
(`zoomAt` interleaves unproject→mutate→re-unproject, iterating 6× for flat non-merc); the
`_cache*` shadows compare _values_ (do **not** introduce a dirty-flag protocol);
`projType`/`globeMode`/`globeOrtho`/`azimuthalProjType` stay in shared `CameraState`. **Honest
read: Camera decomposes into a STATE record + two stateless-ish service objects that both
reference it — not two independent peers.**

### Portfolio summary table

| Unit                   | LOC  | Layer | Risk     | Value    | Cleanest-first cut (+ gate)                                                                                           | Decomposition coupling                                                                              |
| ---------------------- | ---- | ----- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **VectorTileRenderer** | 3962 | L3    | high     | high     | `LabelFeatureSource` — `_label-anchor-parity` + `_projection-label-onscreen` + `merc-high-pitch-drag-perf`            | RenderLoop/passes (contract=`render()` sig), TileCatalog, map.ts, MapRenderer; GPU triad LAST+alone |
| **XGISMap**            | 3494 | L4    | moderate | high     | `FeatureUpdateQueue` — vitest chars + byte-drift + pixel-match (CPU/CI)                                               | VTR (8-call setter ritual; collapse FIRST), MapRenderer, RenderLoop host fields                     |
| **TextStage**          | 1465 | L3    | moderate | high     | `TextShaper` — wrap/vertical/edge suites green + pixel-match (write `prepare()` chars FIRST)                          | IconStage (`droppedPairKeys` order), label-pass (sole caller); no other god-object coupling         |
| **MapRenderer**        | 915  | L3    | moderate | moderate | `GraticuleOverlay` (prove) → `PolygonPipelineFactory` — byte-drift + `_wgsl-compile-gate`                             | VTR (provider→consumer; lead/lockstep); **one-line cycle fix is Wave 0**                            |
| **TileCatalog**        | 1415 | L2    | moderate | high     | `LoadTracker` — `tile-catalog-multi-backend` + `getTileState` (CPU/CI)                                                | VTR (per-frame driver; sequence together), loader, `sources/*`                                      |
| **Camera**             | 1114 | L0    | moderate | high     | `Unprojector` — ortho-unproject-parity + camera-z0-probe + visible-world-copies + interaction-contract-gates (CPU/CI) | projections-table SoT; loader edge → R-B; EARLY pilot                                               |

---

## 4. Prioritized sequence — the recommended ORDER

The order optimizes **risk × value × coupling**: (a) prove the pattern on a _clean-boundary,
CI-gated_ unit before the hot path; (b) provider before consumer; (c) highest-value-highest-risk
(VTR) in the middle once de-risked.

**Wave 0 — zero-behavior-change prep (no new files).**

1. **Break the renderer↔paint cycle with one import retarget** (`paint-shape-resolve.ts:25` →
   `./renderer-helpers`; B5). No `paint-interp.ts`.
2. **Land the boundary lint, enforcing-with-named-allowlist** (§2.3 / C3): it asserts the four
   existing ratchet gates (compiler↛runtime, map↔render-loop type-only `:64-76`, `LOC_CEILINGS`
   shrink-only `:80+`, Gate-4 projType allowlist) **plus** the downward directions the graph
   already satisfies (render→data/eval; camera→coords). Each residual upward read
   (camera→loader, camera→`getMaxDpr`, camera/globe/view-matrix→`gpu-shared` constants) is an
   **explicit allowlist entry with a TODO pointing at R-A/R-B/R-C (§5)**. This is the _honest_
   form the reviewer demanded — not "warn-only with a large opaque baseline".

**Wave 1 — Camera (prove the pattern on the cleanest external boundary, L0).** Its external
read-boundary is the cleanest (controllers consume mutators, passes consume builders, single
crossing edge = tile-select reading both); math kernels already extracted to
`camera-helpers.ts`/`view-matrix.ts`/`unproject.ts`. First cut `Unprojector` is CPU/compute →
strongly CI-covered. Lands _before_ VTR/map.ts because the render-loop frame-push targets its
`CameraState` record.

**Wave 2 — TextStage (independent standalone pilot; build the missing test seam, L3).** Zero
coupling to other god-objects. Begins by _writing characterization tests_ for `prepare()` before
any cut, setting the "characterization-tests-first" norm before high-risk VTR work. First cut
`TextShaper` is pure math, already test-seamed.

**Wave 3 — MapRenderer `PolygonPipelineFactory` seam (de-risk VTR's provider, L3).** Prove the
mechanism on `GraticuleOverlay`, then de-duplicate the MapRenderer→VTR pipeline-handoff (the ~25
setter calls become "VTR consumes the factory"). Gated by byte-drift snapshot +
`_wgsl-compile-gate` (CI). The lockstep partner of VTR.

**Wave 4 — VTR (#1 pilot) + TileCatalog, sequenced together (L3 + L2).** Highest value/risk,
placed _after_ the pattern is proven and the provider seam de-risked. They share the
`onTileLoaded` + per-frame-pump contract. Internal order: clean CPU-ish position-gated cuts
first (`LabelFeatureSource` → `FrameDrawStats` → `TileSelectionCache`), then `FeatureDataBinder`
→ `BindGroupRegistry`, and the **GPU-memory triad `GpuTileStore` + `TileUploader` LAST**, on its
own PR, with warm-harness numeric perf + the screenshot-eyeball loop (the one step CI cannot
fully gate — real-GPU per [R3]). TileCatalog's `TileDataCache` extracts first within its half
(everything writes `_cachedBytes`).

**Wave 5 — XGISMap (`SceneBuilder` etc.), last, after VTR's setter-collapse (L4).** Its biggest
extraction depends on VTR first absorbing `configureFromRenderer(renderer)`. The _cleanest_ cut
(`FeatureUpdateQueue`, CPU-only) may opportunistically land early; the bulk
(`SceneBuilder`/`MapLifecycle`) waits for Wave 4 so the consumer contracts are settled and the
synthetic-bg/`vtSources`/`setQuality` hazards are touched once.

**(Optional) Wave 6 — retire the lint allowlist (R-A/R-B/R-C, §5).** Only after Waves 1–5, and
only if the edges still matter. These are _real refactors_, explicitly out-of-band from the
relocate-only waves.

**Summary.** Wave 0 prep → Camera → TextStage → MapRenderer → (VTR + TileCatalog) → XGISMap →
(optional) sever residual edges. Clean/CI-gated first; provider before consumer;
highest-value-highest-risk in the middle once de-risked; wiring hub last. Within every unit:
clean/CPU/position-gated cuts first; GPU-memory/byte-layout cuts last and alone.

---

## 5. Optional follow-up refactors (NOT preconditions — the path-(b) work, explicitly fenced)

These retire the named lint-allowlist entries. They are **real edits**, not relocations, and are
**not required** for any decomposition wave. Each is independently shippable and CI-gated.

- **R-A — hoist coordinate constants to L0.** Move `WORLD_MERC` / `TILE_PX` from
  `gpu/gpu-shared` into `coords/` (e.g. `projection/projections-table` or a `coords/constants`),
  re-export from `gpu-shared` for back-compat. Retires the `globe.ts:22` / `view-matrix.ts:20` /
  `camera.ts:5` allowlist entries. Gate: byte-drift + type-check; pure constant relocation.
- **R-B — drop the pure converter to L0.** Move `lonLatToMercator` from `loader/geojson` into
  `projection/mercator` (it is pure coord math, miscategorised in the loader), re-export for
  back-compat. Retires the `camera.ts:3` violation — the _one true_ upward edge.
- **R-C — inject DPR instead of reading it.** Replace `camera.ts:6`'s `getMaxDpr` import with a
  DPR scalar passed in from L4 at construction/update. Retires the last L0→L1 platform read.

> **Why these are fenced as optional:** per C2/C3, the load-bearing artifact is the _enforced
> direction rule_, not a clean directory. The lint already enforces direction with a small named
> allowlist; R-A/R-B/R-C merely shrink the allowlist to empty. Doing them is good hygiene;
> _requiring_ them before any split would be the same "rename-only move that is secretly a
> refactor" the reviewer rejected.

---

## 6. Verification (kept — review affirmed)

Per [ADR-0004](docs/adr/0004-verification-gate-strategy.md), two-tier, and that tiering dictates
which cuts are CI-safe:

- **Tier 1 — CI, no GPU (SwiftShader).** vitest over compiler/blueprint/runtime; the render-gate
  job runs `_shader-math-parity`, `_wgsl-compile-gate`, `_vs-clip-parity`, `_dequant-parity`; the
  **polygon-variant byte-drift gate** pins emitted GPU bytes. CPU-only cuts (map.ts
  patch-coalescing, TextStage shaping math, TileCatalog cache, the Camera `Unprojector`) are
  fully covered here. **The new boundary lint runs here** (pure import-graph read; SwiftShader-
  safe).
- **Tier 2 — local / pre-push, real GPU (headed).** pixel-match survey,
  `_projection-label-onscreen` + `_label-anchor-parity` (label _position_, not pixels), globe /
  non-Mercator render matrices, the autonomous screenshot-eyeball loop. Any cut touching the
  raster path (the GPU-memory triad) ships _alone_ with a warm-harness numeric perf comparison
  vs the Mercator control.

`bun run build` (tsc — vitest does not typecheck) gates every step. Each step is one PR;
authoring and the approval pass stay in separate lanes (no self-approval).

### The four ratchet gates this decomposition must keep green (re-verified, kept)

1. **Gate 1 — package acyclicity.** `compiler` must not import `@xgis/runtime`
   (`architecture-invariants.test.ts:57-60`).
2. **Gate 2 — map↔render-loop value cycle stays broken.** `render-loop.ts` imports `./map`
   `import type` only (`:64-76`).
3. **Gate 3 — LOC ceilings (shrink-only).** `LOC_CEILINGS` (`:80+`); high-water 2026-06-09;
   lower as files shrink, fail new over-budget.
4. **Gate 4 — projType integer-literal allowlist (the SoT defense).** projType literals only at
   the confirmed sites — camera 7, controller 6, unproject 4, tiles-sse 3, raster 2,
   prefetch/point/tile-select 1 each — everything else derives from `projections-table`
   predicates (the SoT; `gpu-shared.ts:303-309` re-exports them downward, verified).

> **Single-barrel ABI (kept).** `package.json` exports only `'.'`; every wave preserves the
> barrel. The decomposition adds _internal_ modules only; the consumer API surface is unchanged.

---

## 7. Open questions

- **Open-Q1 — `getMaxDpr` injection (R-C).** Is there any frame where the camera needs DPR
  _before_ L4 can supply it? If yes, R-C needs a default; if no, R-C is trivial.
- **Open-Q2 — `filter-eval ↔ tile-catalog` coupling (unmeasured).** This doc has **not** traced
  whether `computeSliceKey` slicing and `tile-catalog` cache keys share state. Until measured, no
  move that depends on that coupling is proposed; both stay internal to `data/`.
- **Open-Q3 — `BackendRegistry` (MapRenderer legacy arm) dead-or-dormant.** Confirm
  `renderToPass`'s `layers[]` loop is empty in production before deleting vs re-homing.

---

## 8. Cross-links

- **[MODULES.md](docs/architecture/MODULES.md)** §4 — the god-object list (note: LOCs **stale**;
  use `LOC_CEILINGS` as the enforced source of truth).
- **`runtime/src/engine/architecture-invariants.test.ts`** — the four ratchet gates (lines
  57-60, 64-76, 80+).
- **[ADR-0001](docs/adr/0001-ecef-tile-pipeline.md)** — the uniform byte layout the per-tile pack
  must not drift (DO-NOT-SPLIT #2).
- **[ADR-0003](docs/adr/0003-shader-dsl-single-emit.md)** — the `polygon-variant-diff` byte-drift
  gate + `PROJECTIONS` SoT.
- **[ADR-0004](docs/adr/0004-verification-gate-strategy.md)** — the two-tier gate strategy; label
  position-gates; pixel-match non-gating for labels.
- **[ADR-0005](docs/adr/0005-synthetic-earth-surface-background.md)** — the synthetic-bg three-way
  cross-ownership hazard in XGISMap (§3.2).
- **[ADR-0006](docs/adr/0006-world-copy-rendering.md)** — per-projType world-copy enumeration the
  Camera `Unprojector` and VTR `TileSelectionCache` both consume.

> **Reminder: DESIGN PROPOSAL — NOT IMPLEMENTED.** No production code is changed by this document.
> The first executable artifact is **Wave 0** (the one-line `paint-shape-resolve` import retarget
>
> - the boundary lint in enforce-with-named-allowlist form), then **Wave 1** (Camera
>   `Unprojector`), each on its own branch, green on the named gates, reviewed in a separate pass
>   (not self-approved).
