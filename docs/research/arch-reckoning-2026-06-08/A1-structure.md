# A1 — Structure / Coupling / God-Files / SOLID

**Axis verdict (5yr sustainability): 2 / 5.** The dependency _direction_ is genuinely sound (acyclic at the package level, verified). Everything else is the problem: a 5,440-line renderer with a 2,054-line method, a "decomposition" that relocated code without decoupling it (proven by a real `map ↔ render-loop` import cycle), and a single-source-of-truth that the doc itself admits is only half-flipped — capability knowledge is still hand-encoded across camera/VTR.

Every claim below is `file:line` verified. FACT = read in code this session. INFERENCE = reasoned from FACT, labeled.

---

## 1. God-file census (exact `wc -l`, this session)

| File                                                | LOC (verified) | Doc-claimed                  | Biggest single method                 | SRP verdict    |
| --------------------------------------------------- | -------------- | ---------------------------- | ------------------------------------- | -------------- |
| `runtime/src/engine/render/vector-tile-renderer.ts` | **5,440**      | 5,440/5,608/5,298 (drifting) | `render()` ~**2,054 LOC** (2526→4580) | catastrophic   |
| `runtime/src/engine/map.ts`                         | **3,431**      | 3,431/2,956/2,827            | `run()` ~527 LOC (1674→2201)          | catastrophic   |
| `compiler/src/ir/lower.ts`                          | **2,184**      | 2,184                        | (not opened)                          | known monolith |
| `runtime/src/engine/text/text-stage.ts`             | **2,040**      | 2,040/1,967/1,942            | `prepare()` ~**903 LOC** (1114→2017)  | severe         |
| `compiler/src/tiler/vector-tiler.ts`                | **2,015**      | 2,015                        | (not opened)                          | known monolith |
| `runtime/src/engine/render/renderer.ts`             | **1,947**      | 1,947                        | `initPipelines()` ~482 (600→1082)     | severe         |
| `runtime/src/data/tile-catalog.ts`                  | **1,388**      | 1,388                        | (not opened)                          | severe         |
| `runtime/src/engine/projection/camera.ts`           | **1,087**      | 1,087/1,210/1,051            | —                                     | moderate       |

**The LOC numbers in the three governing docs disagree with each other and with reality** (VTR cited as 5,440, 5,608, and 5,298 across MODULES.md / sustainability-doc / its own table). FACT. INFERENCE: the docs are snapshots taken at different commits and there is no CI LOC-budget gate, so the god-files drift freely — nothing blocks growth. The sustainability doc's own Phase 5 admits this ("structure without enforcement decays").

---

## 2. SRP violations — distinct responsibilities per top file (method-group evidence)

### 2.1 VectorTileRenderer (5,440 LOC, 60+ methods, 1 class) — **≥7 distinct responsibilities**

Its own header narrows the contract to "GPU buffers, bind groups, and draw calls only." The method roster (grep, line-cited) contradicts that. Distinct responsibility clusters:

1. **GPU buffer pool / arena management** — `_bufferBucketSize:214`, `acquireBuffer:219`, `releaseBuffer:226`, `getOrCreatePolyVertexArena:455`, `getOrCreatePolyIndexArena:477`, `_allocPolyPair:1797`, `_compactPolyArenas:5358`.
2. **Per-layer tile cache (CPU-side state TileCatalog supposedly owns)** — `getLayerCache:157`, `getOrCreateLayerCache:160`, `getCacheSize:1228`, `hasFeatureData:1224`. MODULES.md §4 says "data/cache/sub-tiling is TileCatalog's" — yet the renderer keeps its own layer→tile maps. FACT: responsibility is split across two god-files.
3. **Tile upload / staging budget** — `uploadTile:1655`, `doUploadTile:1811` (~365 LOC), `doUploadTileAsync:2176` (~350 LOC), `drainPendingUploads:1723`, `resetUploadFrameCap:1701`, `cancelStaleUploads:1755`, `pumpPrefetch:923`.
4. **Bind-group factory** — `rebuildTileBindGroups:630`, `rebuildPerTileFeatureBindGroups:690`, `buildFeatureDataBuffer:1373`, `buildPerTileFeatureData:1501`, `setBindGroupLayout:564`.
5. **Pipeline registry / setters** — `setExtrudedPipelines:507`, `setGroundPipelines:518`, `setPatternPipelines:528`, `setPatternExtrudedPipelines:538`, `setOITPipeline:550` (5 setters = no pipeline registry).
6. **Eviction / byte-budget GC** — `evictGPUTiles:5110`, `_releaseTileSlots:5232`, `forceEvictBytes:5294`.
7. **Draw dispatch + visibility selection (fused)** — `render():2526` is a single **~2,054-line** method (next sibling `recordTileFill` is at 4580). This one method holds visibility selection, world-copy enumeration, per-tile draw recording, and projection branching. A 2,000-line method is not testable in isolation, not reviewable, and is the literal definition of "bugs you can't see from code alone."
8. **Label/feature data export** — `forEachLabelFeature:1151`, `forEachLineLabelFeature:1182`, `forEachLineLabelPolyline:1210`, `getPropertyTable:1138` (the renderer is also a feature-data provider to the text subsystem).

INFERENCE: items 2, 7, 8 alone are three separable classes (GPUTileCache, TileRenderPass, FeatureDataProvider). The sustainability doc's Phase 3 names exactly these (GPUTileCache / TileUploadScheduler / TileBindGroupFactory / TileVisibilitySelector / WorldCopyEnumerator) — **unexecuted.**

### 2.2 XGISMap (3,431 LOC, **126 methods**) — **≥8 distinct responsibilities**

Method grep (line-cited) shows it is a god-object that is simultaneously:

1. **Public camera API** — `setCenter:765`, `setZoom:766`, `setBearing:920`, `setPitch:921`, `panBy:918`, `zoomIn/Out:771-772`, `fitBounds:849`, `easeTo:907`, `flyTo:911`, `jumpTo:925`, `getCameraState:938`.
2. **Source / data ingest** — `run:1674`, `runBinary:2603`, `load:2699`, `setSourceData:3278`, `setSourcePoints:3296`, `updateFeature:3306`, `teardownSource:3161`, `_reprojectIngest:2220`.
3. **Layer compile / paint** — `rebuildLayers:2229`, `setPaintProperty:2955`, `getPaintProperty:3012`, `classifyVectorTileShows:2882`, `groupOpaqueBySource:2913`, `getLayer:2930`.
4. **Event system** — `on/off/once` overloads `:3053-3067`, `addEventListener:3032`, `_fireMapEvent:3075`, `_fireLoadEvent:3092`, `_dispatchMapEvent:3102`.
5. **Interaction / input** — `_onKeyDown:726`, `_processCameraEvents:2767`, `switchController:1511`, `clientToLngLat:1669`, `pickAt:1142`.
6. **Accessibility** — `_setupAccessibility:683`, `_injectFocusStyle:708` (bolted on; FACT it lives directly in the god-object).
7. **Render-frame orchestration** — `renderFrame:2917`, `shouldRenderThisFrame:2815`, `hasPendingSourceWork:2850`, `_markDirty:446`, lifecycle `stop:3393`, `destroy:3215`.
8. **~30+ debug/diagnostic accessors** — `getDumpedLabels:1353`, `getHaloDebug:1431`, `getCameraDebugSnapshot:1411`, `getLastDrawSample:1450`, `setLabelDebugHook:1468`, `getTileLoadDiagnostic:1383`, etc. Production API surface is polluted with test-only probes.

Plus **18 `_warnUnsupported` stub methods** (`setStyle:871`, `addLayer:874`, `removeLayer:877`, `addSource:880`, `addImage:886` …) — MapLibre-compat shims that warn and no-op. FACT.

### 2.3 TextStage (2,040 LOC) — **≥6 responsibilities, one 903-LOC method**

Imports reveal it directly touches 7 internal subsystems (`text-collision`, `text-renderer`, `text-resolver`, `glyph-atlas-gpu/host`, 4× `sdf/pbf/*`, `frame-arena`). The pipeline is fused into **`prepare()` ~903 LOC** (1114→2017): resolve → layout → collision → raster → atlas-pack in one method. Distinct concerns: glyph provider registry (`addGlyphProvider:874`, inline/pbf providers), DPR/typography (`setDpr:881`, `typographyFor:886`), curved-line layout (`addCurvedLineLabel:943`), point-label layout (`addLabel:1059`), the fused `prepare()`, GPU draw (`render:2017`), plus a debug-dump cluster (`getDumpedLabels:1029`, `getHaloDebug:1046`, `setLabelDebugHook:921`). The sustainability doc flags **0 dedicated unit tests** historically — a 903-line untested method is the single highest-risk surface in the tree.

### 2.4 MapRenderer (1,947 LOC) — **≥5 responsibilities**

`initPipelines:600` (~482 LOC), variant pipeline cache (`getOrCreateVariantPipelines:1413`, `createVariantPipelinesAsync:1555`, `buildVariantDescriptors:1460`), compute-layer registry (`ensureComputeRegistry:414`, `dispatchComputePass:428`), graticule (`initGraticule:1701`, `setGraticuleEnabled:401`), OIT/overdraw compositing (`ensureOverdrawCompose:570`), and uniform-ring bookkeeping (`allocUniformSlot:1131`, `stageUniformSlot:1120`). It overlaps VTR on uniform-ring + pipeline-setter responsibilities — two god-files doing variants of the same job.

---

## 3. Worst coupling — the `map ↔ render-loop` cycle + the half-flipped authority

### 3.1 A REAL import cycle (not just "tight coupling") — FACT

The "render redesign" that supposedly extracted the frame loop did **not** break the dependency:

- `map.ts:27` → `import { RenderLoop } from './render-loop'`
- `render-loop.ts:36` → `import { XGISMap } from './map'`

This is a **bidirectional module import cycle.** `render-loop.ts:37` defines its `host` type as `Pick<XGISMap, …>` — it cannot exist without the god-object's type. The header is honest about it (`render-loop.ts:3-8`): _"This is a RELOCATION, not a decoupling… the ONLY mechanical change is `this.X` → `this.host.X`."_

**Quantified blast:** render-loop reaches **43 distinct `host.<field>` accessors** (grep), of which ~20 are private `_`-prefixed map internals (`host._needsRender`, `host._interacting`, `host._flickerLog`, `host._lastSigBearing`, `host._scratchEmittedTextNames`, …). FACT. The encapsulation boundary between "the map" and "the render loop" is fiction — they share private state through a typed view. INFERENCE: you cannot unit-test the render loop without constructing (or mocking ~43 fields of) the entire 3,431-line XGISMap.

### 3.2 PROJECTIONS authority inversion — VERIFIED, and only PARTIALLY fixed

The sustainability doc ranks this **#1 debt**. Status as of this session is more nuanced than "broken":

**Genuinely good (say it once, with evidence):** the world-copy / sphere-routing predicates HAVE been flipped — `worldCopiesFor` / `enumerateWorldCopies` / `routeToSphereSelector` are now **defined in** `projections-table.ts` and `gpu-shared.ts:306-308` merely _re-exports_ them. **13 files import directly from `projections-table`** (grep list incl. camera, globe, tile-select, label-pass, render-loop, shader-dsl). That slice of the flip is done and pinned by `projections-table.test.ts` + `projection-threshold-drift.test.ts`. The header (`projections-table.ts:15-21`) documents it accurately.

**Still inverted (the debt is not closed):** capability _predicates_ are still hand-encoded as integer-literal comparisons at the call site instead of deriving from the table:

- `camera.ts:982` and `camera.ts:1064` — `if (this.projType === 1 || this.projType === 2 || this.projType === 6)` — this is the **cylindrical/periodic family** open-coded twice in one file. There is no `isCylindricalProj(projType)` helper; the set membership lives as a literal triple. FACT.
- `camera.ts:917` — `if (this.projType === 3 && !this.globeMode)` — the ortho z0 special-case, a magic `3`. FACT.
- `camera.ts:733` — `if (this.projType !== 0)` — "is mercator" open-coded. FACT.
- `vector-tile-renderer.ts:2715` — `(projType >= 1 && projType <= 6)` — "flat non-globe" as a numeric range. FACT.

`camera.ts` contains **48** projType-literal/proj-knowledge hits (grep count); VTR contains **22**. INFERENCE: the header's own "Scope note (H1a)" admits the lossy capability collapses were deferred to a future "H1b (EffectiveProjection)" that has not landed — so the table is the SoT for _world-copy enumeration_ but NOT yet for _isCylindrical / isFlat / isOrtho_ membership. The doc's Phase-1 helpers (`isCylindricalProj/isFlatProj/needsBackfaceCull`) are **not exported** — verified by their absence from the grep of table imports. The #1 debt is ~40% closed.

---

## 4. Change blast-radius — two concrete change types

**(a) Add a new projection (e.g. projType 8 = "conic"):** **37 files** match the projection-knowledge fingerprint (`projType` / `PROJECTION_NAME_TO_TYPE` / `SELECTOR_PROJ_NAMES` / `projections-table` / `setProjection` / `getViewForProjection`), grep-counted. The _ideal_ is 1 (add a table row). Of those 37, the table flip removed world-copy/routing edits, but you still must hand-touch `camera.ts` (the `=== 1 || === 2 || === 6` family literals at 982/1064, plus the `=== 3`/`!== 0` cases), `vector-tile-renderer.ts:2715` (the 1..6 range), and the WGSL `shaders/projections.ts` emit. **Realistic blast: ~6–10 files of genuine logic edits, ~37 files in the dependency cone.** FACT (file count) + INFERENCE (logic subset).

**(b) Add a new layer/paint type:** **27 files** match `ShowCommand` / `renderer-types` / `classifyVectorTileShows` / `LayerDrawPhase`. The sustainability doc confirms the root cause: `ShowCommand` carries **untyped flat fields** and the renderer "infers type by field presence" — there is no `LayerType` enum, no paint union, no `LayerCapabilities` table (sustainability-doc line 18). INFERENCE: adding a paint type means editing the flat struct + every presence-sniffing branch across those 27 files, with no compiler-enforced exhaustiveness — the exact shape that produces silent "this layer renders wrong" bugs.

---

## 5. Dependency direction — the one genuinely sound thing

**Package layering is acyclic and correctly directed. FACT:**

- `compiler/src` imports `@xgis/runtime`: **0 times** (grep). The only mention is a comment at `node-to-wgsl.ts:20` explaining _why_ the edge is forbidden ("would create a cycle"). The compiler keeps a self-contained WGSL `emit` copy to avoid the back-edge.
- `runtime/src` imports `@xgis/compiler`: **52 non-test files** (grep). One-directional `runtime → compiler`.
- `@xgis/shared` (ecef.ts) is a true leaf imported by both — the shared-kernel pattern is correctly applied.

So at the **package** granularity the DAG is clean and defended by a test + a tsconfig `rootDir` constraint. This is the codebase's strongest structural asset and should not be disturbed.

**At the module granularity inside `runtime/src/engine/`, the picture is worse:** the `map.ts ↔ render-loop.ts` pair is a confirmed 2-node cycle (§3.1). The `gpu-shared.ts` constants hub has fan-in of **16 files** and `gpu-shared` re-exports `projection` predicates while `projection/camera` imports `gpu` — i.e. `gpu ↔ projection` is a cross-import relationship the MODULES.md table itself annotates as "auth flip" / "re-export only." INFERENCE: these are the seams where "I changed the projection table and a GPU draw broke" bugs live — the doc's "recurring CPU↔GPU drift bug class."

---

## 6. Bottom line for the owner

- The architecture has **one real strength** (acyclic package DAG, defended by a test) and the team knows it.
- The "redesigns" that have shipped are **relocations, not decouplings**: `render-loop` extraction left a bidirectional import cycle and 43 private-field reach-throughs; the PROJECTIONS flip closed world-copy routing but left capability membership hand-coded across camera/VTR (~40% done). The docs themselves admit both ("RELOCATION, not a decoupling"; "Scope note H1a … migrate later").
- **The decomposition plan exists and is correct** (sustainability-doc Phases 0–5, MODULES.md §4). It is **unexecuted.** That is the core finding: the problem is not a missing diagnosis, it is **non-execution + zero enforcement** (no LOC budget gate, no projType-literal lint, so the god-files and scattered literals keep growing). A 2,054-line `render()` method and a 903-line `prepare()` method are why bugs are invisible from code alone — no human or test can hold those methods in working memory.
- A genuinely good test of progress: a CI gate that (1) fails new files >800 LOC in `render/`, (2) forbids `projType === <int>` outside `projections-table.ts`, (3) breaks the `map → render-loop → map` cycle. Until those exist, every refactor decays back.
