<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-03 -->

# data

## Purpose
The CPU-side tile data layer. `TileCatalog` is the router/cache the vector-tile renderer talks to: it dispatches `(z, x, y)` requests to attached per-format `TileSource` backends (PMTiles, virtual-PMTiles-from-GeoJSON, in-memory GeoJSON), and owns the format-agnostic cross-cutting concerns — LRU cache, byte-aware eviction (200 MB desktop / 100 MB mobile), per-frame fetch concurrency budget, sub-tile generation at over-zoom, and `onTileLoaded` fan-out. This dir also holds the CPU frustum + sampled tile-selection algorithms, raster tile URL/loading helpers, polar-cap synthesis for pre-tiled MVT sources, and the `TileCoord` / `TileData` types that flow from backends through the catalog to the GPU renderer. GPU-independent: this dir manages CPU typed arrays only — GPU upload is the renderer's job.

## Key Files
| File | Description |
|------|-------------|
| `tile-catalog.ts` | `TileCatalog` — routes requests to `TileSource` backends, owns dataCache + synthesised `XGVTIndex` + per-backend sink closures (stamp `TileData.originBackend`) + `getScheme()`. Delegates two concerns to collaborators (parallel-axis split): byte+count LRU/skeleton/evict-shield eviction → `tile-eviction-policy.ts` (`TileEvictionPolicy`), per-frame compile + sub-tile budget → `tile-compile-budget.ts` (`CompileBudget`); `cacheTileData` takes a `CacheTileDataDescriptor` (struct, not positional args). Primary surface the VTR depends on. |
| `tile-eviction-policy.ts` / `tile-compile-budget.ts` | Collaborators extracted from `TileCatalog` (parallel-axis split). Eviction policy (LRU + byte cap + skeleton survival + evict-shield) and the per-frame compile/sub-tile budget; the catalog owns + delegates. Add eviction/budget logic here, not back in `tile-catalog.ts`. |
| `tile-source.ts` | `TileSource` per-format backend protocol + `TileSourceSink` push-based result delivery. Push (not promise-return) so batch range-request backends can fan out results as they decode. Also exports `TILE_LAYOUT_VERSION`, `TileScheme`, and `TileSourceMeta`. |
| `tile-types.ts` | Shared lifecycle types: `TileData` (CPU polygon/line/point typed arrays + DSFUN/ECEF strides + `originBackend` reverse pointer), `TileState` state-machine enum, `MAX_CACHED_TILES`, `maxCachedBytes()`, `maxConcurrentLoads()`, `defaultSkeletonDepth()` — all viewport-aware lazy functions to avoid Playwright DPR-init races. |
| `tile-select.ts` | Public re-export façade for frustum-based tile selection. Hosts `visibleTilesFrustum` / `visibleTilesFrustumSampled` + raster `loadImageTexture`/`tileUrl`; re-exports pure helpers from sibling modules. Tile budget is viewport-aware: `maxFrustumTilesFor()` (≤ 300 desktop, tighter on mobile). Classifier uses `PROJECTION_NAME_TO_TYPE` table (not lossy name comparison). |
| `tile-select-helpers.ts` | Pure tile-math free functions: `firstIndexedAncestor` quad-tree walk (cap z=22 DSFUN ceiling), `worldCopyOf`, `makeTileCoord`, `visibleTiles`, `tileBounds`, `tileUrl`, `isTileTemplate`, `sortByPriority`. No module-level mutable state. |
| `tile-select-types.ts` | `TileCoord` (wrapped `x` + absolute `ox` for world-copy shift — misusing `ox` as a copy index causes multi-thousand-degree longitude offsets, a live regression at commit 71dd401) and `LoadedTile`. |
| `tile-catalog-helpers.ts` | Single pure free function `unionBounds` — lon/lat rectangle union used by `TileCatalog.mergeBackendMeta` when multiple backends contribute coverage. |
| `sub-tile-generator.ts` | `SubTileGenerator` — at over-zoom past archive `maxZoom`, clips parent tile geometry into sub-tile rectangles in tile-local Mercator meters and re-packs into the sub-tile's DSFUN/ECEF frame for seamless joins. Pure wrt catalog state; unit-testable in isolation. |
| `polar-cap-synth.ts` | Synthesises polar-cap GeoJSON `FeatureCollection`s for PMTiles/TileJSON sources (pre-tiled MVT has no polygon to anchor a cap to). `projectionNeedsPolarCaps` returns false for Mercator/oblique-Mercator (pole singularity). Host attaches the result as a separate source styled to match ocean/land. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `eval/` | Filter / extrude / feature-id expression evaluators and slice keying (see `eval/AGENTS.md`). |
| `sources/` | Per-format `TileSource` backends: PMTiles, virtual-PMTiles, GeoJSON-runtime, EPSG reprojection, synthetic earth-surface (see `sources/AGENTS.md`). |
| `workers/` | MVT + GeoJSON decode/compile/tiling Web Worker pools (see `workers/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- **Tile selection + budget is bug-prone.** `tile-select.ts` (frustum), the catalog cache/eviction, and the renderer's per-frame upload budget interact through implicit caps. The `firstIndexedAncestor` walk in `tile-select-helpers.ts` caps at z=22 (DSFUN ceiling); the old 2-level cap caused over-zoom black-screen.
- **`TileCoord.ox` is the absolute tile-x including world-copy shift** — not a copy index. Getting this wrong (copy index instead of `x + copy * 2^z`) blanks the canvas with thousand-degree offsets; this is a live regression history (commit 71dd401).
- **Push-based sink is intentional.** `TileSourceSink.acceptResult` is the only delivery path; do not convert backends to promise-return — batch range-request backends rely on push to fan out mid-batch.
- **Catalog is GPU-free.** Do not introduce GPU types here; the renderer owns upload.
- **Viewport-aware caps are lazy functions, not module-init constants.** `maxCachedBytes()`, `maxConcurrentLoads()`, `defaultSkeletonDepth()` all read `window.innerWidth` lazily per call (with microtask-invalidated memo) to avoid Playwright mobile-DPR-init races. Do not hoist them to top-level constants.
- **`TileScheme` discriminator:** currently the single-variant `'web-mercator-xyz'` literal. Future variants (`'epsg-4326-quadtree'`, `'s2-cube-sphere'`) are JSDoc-reserved but NOT in the union body — do not add them until their backend implementation lands.
- **Non-merc sphere-routed projections over-select at high pitch.** projType 3–7 can select ~4.5× more tiles than Mercator at z=14+pitch. The `non-merc-z14-over-select.test.ts` gate enforces ≤ 2× ratio; any change to frustum budget logic must keep this passing.
- **`TileData.originBackend`** is stamped by the per-backend sink closure in `TileCatalog.makeSink`. It is used by `evictTilesForBackend` for per-backend cache invalidation on `TILE_LAYOUT_VERSION` mismatch — do not strip it when constructing synthetic tile results.

### Testing Requirements
- Dense suite: `tile-cross-path-invariants.test.ts`, `tile-selection-{dpr,pitch,semantic}.test.ts`, `tile-high-pitch-coverage.test.ts`, `tile-sampled-algorithm.test.ts`, `tile-animation-coverage.test.ts`, `first-indexed-ancestor.test.ts`, `polar-cap-synth.test.ts`, `sub-tile-generator.test.ts`, `tile-catalog-{skeleton,multi-backend,layout-version-eviction}.test.ts`.
- New gates added on ship-P0 branch: `tile-select-classifier-table.test.ts` (PROJECTION_NAME_TO_TYPE lookup equivalence for all live projections), `non-merc-z14-over-select.test.ts` (sphere-routed projs ≤ 2× Mercator tile count perf gate), `tile-catalog-scheme-accessor.test.ts` (`TileCatalog.getScheme()` lifecycle), `tile-source.scheme.test.ts` (backends declare `meta.scheme`), `tile-data-origin-backend.test.ts` (`TileData.originBackend` reverse pointer), `tile-layout-version.test.ts` (layout version eviction).
- Gate selection/budget changes on concrete e2e tile counts + p95/max ms vs a Mercator control.
- Add cross-path invariant coverage for any new selection or clip logic.

### Common Patterns
- Router/backend split: format-specific code lives in a `TileSource` implementation; format-agnostic state (cache, eviction, budget) stays on `TileCatalog`.
- Sub-tile and polar-cap geometry computed in tile-local Mercator meters, packed in DSFUN/ECEF.
- Extracted pure-helper siblings (`tile-select-helpers.ts`, `tile-catalog-helpers.ts`) are behaviour-preserving structural splits — no logic changes.

## Dependencies

### Internal
- `engine/gpu/gpu-shared` (`worldCopiesFor`, `TILE_PX`), `engine/projection/` (`MERCATOR_LAT_LIMIT`, `projection`, `projections-table`, `globe`), `engine/safety` (`assertSafeRemoteUrl`), `engine/log`, `core/` (priority queue), `@xgis/compiler` (tile keys, `CompiledTile`, decode/compile, clip/tessellate primitives).

### External
- `pmtiles`.

<!-- MANUAL: notes below this line are preserved on regeneration -->
