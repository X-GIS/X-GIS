<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-03 -->

# render

## Purpose
All GPU draw-call renderers, per-frame scheduling, and paint-resolution glue for the X-GIS WebGPU engine. `renderer.ts` (`MapRenderer`) drives compiled GeoJSON meshes (fill/line/point + graticule, OIT, overdraw-debug); `vector-tile-renderer.ts` (VTR, ~5600 LOC, #1 debt file) drives the tile path — tile selection, classification, GPU buffer/bind-group management, GPUArena eviction, and the draw loop over a `TileCatalog`. Specialized renderers handle SDF lines, SDF points, raster tiles, and line-pattern/dash. `FrameContext` + `SceneView` + `RenderTargets` are the per-frame value objects passed through the fixed render-pass chain defined in `passes/`. The bucket scheduler classifies opaque/translucent/OIT shows; `ResolvedShow`/`paint-shape-resolve` collapse zoom/time animation to per-frame scalars; `compute-*` modules wire per-feature GPU compute-paint kernels; `UniformRing` manages the growable per-draw uniform ring buffer shared by both renderers; `BundleCache` replays cached `GPURenderBundle`s to cut steady-state CPU encode overhead.

## Key Files
| File | Description |
|------|-------------|
| `renderer.ts` | `MapRenderer` — WebGPU renderer for compiled GeoJSON meshes: polygon DSL emit via `emitPolygonWgsl`, OIT/overdraw-compose pipelines, graticule, `UniformRing`, `ComputeLayerRegistry`. |
| `vector-tile-renderer.ts` | VTR — tile selection + GPUArena eviction + GPU buffer/bind-group lifecycle + draw loop over `TileCatalog`. The tile-path hot loop; #1 debt file (~5600 LOC). |
| `frame-context.ts` | `FrameContext` interface — single reused per-frame value object holding device, encoder, camera, projType, w/h/dpr, sampleCount, elapsedMs, frameCount. Mutated in place (allocation-paranoid). |
| `render-targets.ts` | `RenderTargets` — owns GPU render-target texture lifecycle (MSAA, stencil, OIT accum/revealage, offscreen-extrude depth, overdraw accumulator, pick RG32Uint); recreates on resize. |
| `scene-view.ts` | `SceneView` interface + builder — per-frame read-only classification of opaque/translucent/OIT shows and `resolveOwner` (which pass claims the MSAA resolveTarget). |
| `frame-draw-stats.ts` | `FrameDrawStats` — per-frame draw accumulators, render-scoped dedup map, tile-drop warning dedup set, decision counts, and draw-order trace stash. Zero GPU state. Extracted from VTR (Cluster G). |
| `line-renderer.ts` | SDF line + polygon-outline renderer: resolution-independent quads, cap/join/dash, per-segment width/z-lift. Re-exports `core/line-segment-build` + `line-pattern`. |
| `point-renderer.ts` | SDF point/circle renderer — single draw call via per-feature storage buffer, `point-vertex-format.ts` layout. |
| `point-renderer-types.ts` | `PointLayer` interface — internal GPU buffer/bind-group/feature-data layout for point layers, including `sizeShape`, `isFlat`, `isTranslucent`, and world-copy expanded-buffer slots. Extracted from `point-renderer.ts` to break the type-import cycle. |
| `raster-renderer.ts` | Raster (texture) tile renderer with GPU projection (`projectWgsl`), opacity, and cull-threshold logic. |
| `line-pattern.ts` | SDF line-pattern + dash config: `LineLayerUniform` layout + pure packing helpers, extracted from the line renderer. |
| `label-feature-source.ts` | `LabelFeatureSource` — CPU label-anchor extraction (point / line-segment / full-polyline) from visible tiles for the `TextStage` label path. Holds line-label run cache + `FrameArena`. Extracted from VTR (Cluster F). |
| `bucket-scheduler.ts` | Pure classifier — orders `vectorTileShows` into opaque / translucent / OIT buckets; splits translucent-stroke layers (fill→opaque, stroke→translucent). |
| `resolved-show.ts` | `ResolvedShow` — per-frame SSA snapshot of a show's paint state; all zoom/time deps collapsed to scalar/RGBA. Sole per-frame paint carrier. |
| `paint-shape-resolve.ts` | Per-frame evaluation of the five `PropertyShape` variants (constant / zoom / time / zoom-time / data-driven). |
| `uniform-ring.ts` | `UniformRing` — growable GPU ring buffer of fixed-size uniform slots; shared by `MapRenderer` and VTR. Carries the iter-348 mid-frame-grow fix (pre-grow draws written to OLD buffer before retire). |
| `bundle-cache.ts` | `BundleCache` — caches `GPURenderBundle`s; steady-state per-show encode runs once and replays via `executeBundles`. |
| `prefetch-scheduler.ts` | Speculative tile prefetch (sibling-load + camera-lookahead) feeding `TileCatalog.prefetchTiles`. |
| `vector-tile-renderer-types.ts` | `GPUTile` (arena-backed vertex/index buffer offsets) and `LayerDrawPhase` (`'all'|'fills'|'strokes'|'oit-fill'`) — extracted from VTR to break the type-import cycle. |
| `renderer-types.ts` | `ShaderVariantInfo`, `CachedPipeline` (fill/line/ground/fallback/pick pipeline set), `ShowCommand`, `RenderLayer` — extracted from `renderer.ts`. |
| `renderer-helpers.ts` | Pure interpolation helpers (`interpolateZoom`, `interpolateTime`, color parsers) re-exported from `renderer.ts` for external consumers. |
| `vector-tile-renderer-helpers.ts` | `getMaxGpuTiles`, `uploadBudgetFor`, `ARENA_HIGH_WATER`/`LOW_WATER` constants — GPU cache caps and per-frame upload budget policy. |
| `compute-feature-packer.ts` | `ComputeFeaturePacker` — packs per-feature expression inputs into GPU storage buffers for compute-paint dispatch; companion to `compute-bind-layout.ts`. |
| `compute-bind-layout.ts` / `compute-layer-handle.ts` / `compute-layer-registry.ts` / `tile-compute-resources.ts` | Per-tile/per-layer compute-paint lifecycle: bind-layout, layer handle, layer registry, tile resource management — GPU per-feature expression evaluation glue. |
| `line-vertex-format.ts` / `point-vertex-format.ts` / `vertex-buffer-layout.ts` | Vertex-buffer stride/attribute layout descriptors for line, point, and polygon passes. Must stay in sync with WGSL `@location` bindings. |
| `__vertex-format-crosscheck.ts` | Static cross-check asserting vertex-format constants match WGSL struct layouts; not a test file but runs at import time under Vitest. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `passes/` | Fixed render-pass chain objects (`RenderPass` interface + background, opaque, OIT, translucent, points, labels, overdraw-compose passes). Each pass is a stateless singleton reading `FrameContext` + `SceneView`. (see `passes/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- **VTR's tile loop + budget is the most bug-prone code in the runtime.** Per-tile branching goes through the pure `engine/tile-decision.ts` `classifyTile`; add new branches there, not as inline `if…continue`. Two prior regressions lived in the old implicit cascade.
- Implicit budgets interact: GPU-cache LRU (`getMaxGpuTiles` ≈ 512), per-frame upload budget (`uploadBudgetFor`), SSE tile demand. Changing one shifts the others — gate on e2e tile/perf numbers vs a mercator control.
- `UniformRing` grows mid-frame; the iter-348 fix writes staged slots to the OLD buffer before retiring it (prevents stale-colour at high pitch / many draws). Re-run `uniform-ring*.test.ts` after any ring/bind-group/per-show buffer change.
- Renderers consume `ResolvedShow` directly — never write back `cs.show.opacity = ...`. Add new animated paint via `paint-shape-resolve.ts`.
- `FrameContext` is a single reused instance (`_ctx`) mutated in place each frame — do NOT cache field values across frames or allocate a new instance per frame.
- Vertex-format files (`line-vertex-format.ts`, `point-vertex-format.ts`) must stay byte-identical to the corresponding WGSL `@location` bindings in `engine/shader-dsl/shaders/`.
- WGSL projection/log-depth blocks come from `engine/shaders` — keep them shared, not copy-pasted into inline template strings.
- `background-renderer.ts` is gone; background is now `passes/background-pass.ts`. Do not reference the old file.
- `point-renderer-types.ts` holds `PointLayer` which is internal (not re-exported); import it only inside `point-renderer.ts` and its tests.

### Testing Requirements
Large suite in this dir: `bucket-scheduler.test.ts`, `bundle-cache.test.ts`, `uniform-ring*.test.ts`, `feature-bindgroup-rebuild.test.ts`, `tile-pitch-throughput.test.ts`, `tile-real-data-coverage.test.ts`, `compute-bind-layout.test.ts`, `compute-layer-handle.test.ts`, `compute-layer-registry.test.ts`, `compute-feature-packer.test.ts`, `tile-compute-resources.test.ts`, shader-marker / cos-c / fragment-cull / vertex-layout consistency tests, dash sim/e2e (`dash-e2e.test.ts`, `dash-shader-sim.test.ts`), interpolate-zoom/time tests, `render-targets.test.ts`, `scene-view.test.ts`, `arena-eviction-policy.test.ts`, `globe-ecef-frame-consistency.test.ts`, `merc-high-pitch-drag-perf.test.ts`. Passes tests live under `passes/` (`background-pass-clear-value.test.ts`, `synthetic-earth-surface-overdraw.test.ts`). Add a `tile-decision` case + a perf/throughput assertion for any tile-loop change.

### Common Patterns
- Pure classifiers extracted from GPU classes: `bucket-scheduler`, `tile-decision` (in `engine/`), `paint-shape-resolve`, `frame-draw-stats`, `label-feature-source`.
- DSFUN positions + camera-relative recovery in vertex shaders (RTC = relative-to-center, not absolute world coords).
- Bundle replay (`BundleCache`) for steady-state CPU savings; bundles are keyed on structural hash of bind-group state.
- `LayerDrawPhase` (`'fills'`/`'strokes'`/`'all'`/`'oit-fill'`) controls the two-pass translucent-stroke path to prevent alpha accumulation across overlapping geometry.

## Dependencies

### Internal
- `data/` (tile catalog, tile select, tile types), `core/` (line-segment build, polygon mesh), `engine/projection` (camera, projections-table, globe), `engine/gpu` (context, shared, uniform, staging, arena, compute, palette), `engine/shaders` (WGSL blocks), `engine/shader-dsl` (polygon/OIT/overdraw DSL emitters), `engine/text` + `engine/sprite` (label/icon stages), `engine/tile-decision`, `engine/render-loop`, `@xgis/compiler`.

### External
- `@webgpu/types`.

<!-- MANUAL: notes below this line are preserved on regeneration -->
