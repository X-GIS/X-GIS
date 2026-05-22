<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# render

## Purpose
Every draw-call renderer plus the per-frame scheduling and paint-resolution glue. `renderer.ts` (`MapRenderer`) is the WebGPU renderer for compiled GeoJSON meshes; `vector-tile-renderer.ts` (VTR) drives the tile path — tile selection, classification, GPU buffer/bind-group management, and the draw loop over a `TileCatalog`. Specialized renderers handle lines (SDF quads), points (SDF circles), raster tiles, line patterns/dashes, and the earth-surface background pre-pass. The bucket scheduler orders opaque vs translucent draws; `ResolvedShow`/paint-shape-resolve collapse per-frame zoom/time animation to scalars; the compute-* modules wire per-feature compute-paint kernels; bundle-cache replays cached `GPURenderBundle`s.

## Key Files
| File | Description |
|------|-------------|
| `renderer.ts` | `MapRenderer` — WebGPU renderer for compiled GeoJSON meshes (fill/line/point), graticule, blend/stencil/OIT setup. |
| `vector-tile-renderer.ts` | VTR — tile selection + classification + GPU buffer/bind-group management + draw loop over a `TileCatalog`. The tile-path hot loop. |
| `line-renderer.ts` | SDF line + polygon-outline renderer (resolution-independent quads, cap/join/dash, per-segment width/z-lift). Re-exports `core/line-segment-build` + `line-pattern`. |
| `point-renderer.ts` | SDF point/circle renderer — single draw call via per-feature storage buffer. |
| `raster-renderer.ts` | Raster (texture) tile renderer with GPU projection (`projectWgsl`). |
| `background-renderer.ts` | Earth-surface fill pre-pass — ONE clip-space fullscreen quad drawn FIRST in the opaque pass (replaces tile/quad-mesh impls that z-fought under log-depth). |
| `line-pattern.ts` | SDF line pattern + dash config: LineLayerUniform layout + pure packing helpers, extracted from the 1700-line line renderer. |
| `bucket-scheduler.ts` | Pure classifier — orders `vectorTileShows` into opaque + translucent buckets (translucent-stroke shows split fill→opaque, stroke→translucent). |
| `resolved-show.ts` | `ResolvedShow` — per-frame SSA snapshot of a show's paint state, all zoom/time deps collapsed to scalar/RGBA. Sole per-frame paint carrier. |
| `paint-shape-resolve.ts` | Per-frame evaluation of the five `PropertyShape` variants (constant / zoom / time / zoom-time / data-driven). |
| `bundle-cache.ts` | `BundleCache` — caches `GPURenderBundle`s so per-show encode runs once; replays via `executeBundles` (single native call). |
| `prefetch-scheduler.ts` | Speculative tile prefetch (sibling-load + camera-lookahead) feeding `TileCatalog.prefetchTiles`. |
| `tile-compute-resources.ts` / `compute-*` | Per-tile/per-layer compute-paint lifecycle: feature packer, bind-layout, layer handle, registry — GPU per-feature expression evaluation glue. |

## For AI Agents

### Working In This Directory
- **VTR's tile loop + budget is the most bug-prone code in the runtime.** Per-tile branching now goes through the pure `engine/tile-decision.ts` `classifyTile`; keep new branches there, not as inline `if…continue`. Two prior regressions lived in the old implicit cascade.
- Implicit budgets interact: GPU-cache LRU (MAX_GPU_TILES≈512), per-frame upload budget (MAX_UPLOADS_PER_FRAME≈4), SSE tile demand. Changing one shifts the others — gate on e2e tile/perf numbers vs a mercator control.
- The uniform ring grows mid-frame; a fixed bug left pre-grow draws on the OLD buffer (stale colours at high pitch / many draws). Re-run `uniform-ring*.test.ts` after any ring/bind-group/per-show buffer change.
- Renderers consume `ResolvedShow` directly — never write back `cs.show.opacity = ...`. Add new animated paint via `paint-shape-resolve.ts`.
- WGSL fragment/vertex shaders are inline template strings; their projection/log-depth blocks come from `engine/shaders` — keep them shared, not copy-pasted.

### Testing Requirements
- Very large suite: `bucket-scheduler.test.ts`, `bundle-cache.test.ts`, `uniform-ring*.test.ts`, `feature-bindgroup-rebuild.test.ts`, `tile-pitch-throughput.test.ts`, `tile-real-data-coverage.test.ts`, shader-marker / cos-c / fragment-cull consistency tests, dash sim/e2e, interpolate-zoom/time tests, compute-* tests. Add a `tile-decision` case + a perf/throughput assertion for tile-loop changes.

### Common Patterns
- Pure classifiers extracted from GPU classes (`bucket-scheduler`, `tile-decision`, `paint-shape-resolve`). DSFUN positions + camera-relative recovery in vertex shaders. Bundle replay for steady-state CPU savings.

## Dependencies

### Internal
- `data/` (tile catalog/select), `core/` (line-segment build, polygon mesh), `engine/projection` (camera), `engine/gpu` (context, shared, uniform, staging, palette), `engine/shaders` (WGSL blocks), `engine/text` + `engine/sprite` (label/icon stages), `@xgis/compiler`.

### External
- `@webgpu/types`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
