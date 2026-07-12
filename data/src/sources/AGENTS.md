<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-23 -->

# sources

## Purpose

Implements every `TileSource` backend the runtime attaches to `TileCatalog`. Each backend owns the full fetch-or-compile cycle for one data origin — PMTiles HTTP archives, in-memory GeoJSON (two variants), the synthetic ECEF background-fill mesh, and a legacy virtual-catalog adapter — and pushes results through the `TileSourceSink` interface so the catalog's GPU upload path is identical regardless of source. This dir also contains the EPSG input-reprojection layer (`epsg-defs.ts` + `reproject-fc.ts`) that normalises any-CRS FeatureCollections to WGS84 before they reach the tiling pipeline.

## Key Files

| File                                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pmtiles-backend.ts`                 | `PMTilesBackend` — two-stage fetch/compile pipeline for PMTiles HTTP archives. Stage 1 (`loadTile`) enqueues async HTTP fetches via a `PriorityQueue` capped at `maxInflight()` (16 desktop / 4 mobile). Stage 2 (`tick`) drains raw MVT bytes to the shared `MvtWorkerPool` per frame, each yielding one `BackendTileResult` slice per MVT layer. Handles exponential-backoff negative caching for failed keys, `AbortController`-based stale-fetch cancellation, and an inline compile fallback for Worker-less environments (vitest).                                                                          |
| `pmtiles-backend-types.ts`           | Type-only split from `pmtiles-backend.ts`: `PMTilesFetcher` (three-state `Uint8Array \| null \| 'failed'` return) and `PMTilesBackendOptions` (layer allow-list, extrude/stroke-width/colour expression ASTs, `showSlices` filter descriptors). Re-exported from `pmtiles-backend.ts` as part of the public surface.                                                                                                                                                                                                                                                                                              |
| `pmtiles-backend-helpers.ts`         | Pure free functions split from `pmtiles-backend.ts`: `extractFeatureHeights/Widths/Colors` (eval expression ASTs against per-feature properties), `maxInflight` (viewport-width-aware concurrency cap), `failedKeyTtlMs` (exponential backoff 15 s → 5 min cap), `tileSizeMerc` (tile dimensions in Mercator metres for the line-segment builder), `tileIntersectsBounds` (lon/lat AABB overlap check).                                                                                                                                                                                                           |
| `virtual-pmtiles-backend.ts`         | `VirtualPMTilesBackend` — serves GeoJSON through the same two-worker pipeline as `PMTilesBackend`. On construction it fires `tilingPool.setSource` to build a geojsonvt index in a worker; `loadTile` chains on that promise then calls `tilingPool.getTile` for PBF bytes before handing them to `MvtWorkerPool`. Inherits paced compile, per-layer slices, extrude/stroke bakes, and the inline compile fallback.                                                                                                                                                                                               |
| `geojson-runtime-backend.ts`         | `GeoJSONRuntimeBackend` — synchronous `TileSource` for raw in-memory `GeometryPart[]` (compiler's pre-parsed form). Builds a z=3 spatial grid (64 cells) at `setParts` time and calls `compileSingleTile` directly on the main thread. Used for small inline GeoJSON where worker round-trip latency exceeds compile time.                                                                                                                                                                                                                                                                                        |
| `synthetic-earth-surface-backend.ts` | `SyntheticEarthSurfaceBackend` — produces the single z=0 background-fill tile that replaced `BackgroundRenderer` (deleted PR 2c.3.B). Generates a 128×64 lon/lat mesh projected to WGS84-ellipsoid ECEF, quantized in the DSFUN double-u16 layout the polygon VS (`vs_main_ecef`) consumes, so the background shares one geoid with real tile polygons. Sphere-class projections (ortho/azi/stereo/globe) get `packECEFWithPolarCaps` which extends true ±90° rows beyond the ±85.05° Mercator clamp to close the polar hole. Emits on `attach` so the catalog has the tile cached before the first render frame. |
| `polar-cap-ecef-pack.ts`             | Shared ECEF packing kernel `packECEFWithPolarCaps` — lifts polar-cap geometry synthesis out of `synthetic-earth-surface-backend.ts` so multiple backends (synthetic earth-surface + per-source GeoJSON polar-cap) can render ±90° caps through the polygon ECEF pipeline. Converts stride-2 lon/lat meshes to quantized POLYGON_FILL_FORMAT with source-honest polar latitude (true ±90 beyond the Mercator ±85.05° clamp) so sphere-class projections close the polar hole. Computes ECEF directly via `lonLatToECEF` for rows beyond the clamp, matching geoid with ground tiles.                               |
| `geojson-polar-cap-backend.ts`       | `GeoJSONPolarCapBackend` — fills a GeoJSON source's ±5° polar hole (issue #360) by serving a single z=0 synthetic tile (parallel to `SyntheticEarthSurfaceBackend`). Detects which pole(s) a source touches via `detectCapPoles`, generates a CAP-ONLY lat/lon mesh, and packs it through `packECEFWithPolarCaps` so caps share one ECEF anchor + geoid with the surrounding ground tiles. Color and source-name derivation preserve per-source layer styling (blue ocean / green land at the pole).                                                                                                              |
| `virtual-catalog-adapter.ts`         | `VirtualCatalogAdapter` — legacy back-compat wrapper for the `setVirtualCatalog` API. Wraps a `VirtualCatalog` (a `CompiledTile`-returning fetcher) in the `TileSource` interface with a flat 32-inflight cap and no two-stage split. New code should use `PMTilesBackend` or `VirtualPMTilesBackend` directly.                                                                                                                                                                                                                                                                                                   |
| `epsg-defs.ts`                       | EPSG registry built on `proj4`. Registers def strings for EPSG:5179 (Korea 2000 UTM-K) and EPSG:5186 (Korea 2000 Central Belt 2010) — codes proj4 does not bundle. `normalizeEPSG` canonicalises any input form (`"5179"`, `5179`, `"EPSG:5179"`); `resolveEPSG` guards that only registered or proj4-builtin codes pass through. Validated at ≤ 3.7 nm divergence against pyproj.                                                                                                                                                                                                                                |
| `reproject-fc.ts`                    | `reprojectFeatureCollection` — reprojects every coordinate in a `GeoJSONFeatureCollection` from any registered EPSG CRS to WGS84 (EPSG:4326) using proj4. Returns a new object (never mutates input). EPSG:4326 → EPSG:4326 is a no-op returning the input reference unchanged. Supports all RFC 7946 geometry types including `GeometryCollection`.                                                                                                                                                                                                                                                              |

## For AI Agents

### Working In This Directory

- Every backend must implement `TileSource` from `../tile-source` — the `attach`, `has`, `loadTile`, and optional `tick`/`cancelStale` contract. `TileCatalog` calls these methods directly per frame.
- `acceptResult(key, null)` (empty placeholder) vs never calling `acceptResult` have different catalog semantics: `null` marks the tile as "present but empty" (stops re-requesting); omitting `acceptResult` leaves the tile "missing" so the renderer's parent-walk falls back to ancestor tiles. Getting this wrong causes either infinite re-requests or lost ancestor fallback.
- `sink.trackLoading(key)` must be paired with exactly one `sink.releaseLoading(key)` on every code path (success, failure, abort, cancel). A missing release drifts the catalog's in-flight counter and stalls future tile requests.
- `pmtiles-backend-helpers.ts` contains an inline compile fallback that must stay byte-identical to the MVT worker (`mvt-worker.ts`). If `extractFeatureHeights/Widths/Colors` changes here, mirror it in the worker.
- `tileSizeMerc` is duplicated in `virtual-pmtiles-backend.ts` and `pmtiles-backend-helpers.ts` — keep in sync.
- `SyntheticEarthSurfaceBackend` anchor latitude `Z0_DECODED_SOUTH = atan(sinh(-π))·180/π` must match the render-side `off` uniform in `vector-tile-renderer.ts`. Never round this to `MERC_LAT_CLAMP`; the ECEF RTC cancellation requires bit-for-bit equality between pack-side and render-side anchor.
- `TILE_LAYOUT_VERSION` must be stamped on every backend's `meta.layoutVersion`; the catalog evicts cached tiles on version mismatch (PR 2c.4).
- `epsg-defs.ts` throws hard on unknown EPSG codes — a silent 4326 fallback would render data at the wrong location. Do not add a fallback.
- Do not add new npm dependencies (project zero-dep rule). `proj4` is the only external import in this dir and is already a declared dependency.

### Testing Requirements

- Vitest unit tests: `geojson-runtime-backend.test.ts`, `pmtiles-backend.test.ts`, `virtual-catalog-fetch.test.ts`, `epsg-defs.test.ts`, `reproject-fc.test.ts`, `synthetic-earth-surface-backend.test.ts`, `synthetic-earth-surface-world-band.test.ts`.
- Tests run without a GPU — PMTiles and VirtualPMTiles fall back to inline compile when `Worker` is undefined.
- `reproject-fc.ts` has a Python cross-validation counterpart in `scripts/cross-validation/` — the 1 mm (1e-3 m at EPSG:3857) tolerance must hold; do not relax it.
- After any change that touches `BackendTileResult` field shapes or vertex layouts, run `bun run build` — vitest does not typecheck.

### Common Patterns

- All Worker-path backends lazy-init a shared `MvtWorkerPool` via `getSharedMvtPool()` stored in `this._pool`; the pool is not created until the first Worker-path compile call.
- Expression AST evaluation uses `evaluate` + `makeEvalProps` from `@xgis/compiler`; per-feature `try/catch` isolation ensures one bad property bag does not drop the whole tile.
- Two-stage fetch/compile with per-frame `tick(budget)`: the split prevents 30+ stacked compile calls blocking frames when many fetches resolve in the same microtask boundary.

## Dependencies

### Internal

- `../tile-source` — `TileSource`, `TileSourceSink`, `TileSourceMeta`, `BackendTileResult`, `TILE_LAYOUT_VERSION`
- `../tile-types` — `VirtualCatalog` (legacy adapter only)
- `../workers/mvt-worker-pool` — `getSharedMvtPool`, `MvtWorkerPool`
- `../workers/geojson-tiling-pool` — `setSource`, `getTile` (`VirtualPMTilesBackend` only)
- `../eval/filter-eval` — `evalFilterExpr`
- `../eval/extrude-eval` — `evalExtrudeExpr`
- `../../core/line-segment-build` — `buildLineSegments` (inline compile fallback)
- `../../core/priority-queue` — `PriorityQueue`, `PriorityQueueItemRemovedError`
- `../../engine/log` — `xlog`
- `../../engine/projection/earth-surface-fill` — `generateEarthSurfaceFillMesh`, `worldBandForProjType`
- `../../engine/projection/ecef` — `tileEcefCenterFromMerc`, `lonLatToECEF`
- `../../loader/geojson` — GeoJSON type aliases (`reproject-fc.ts` only)

### External

- `@xgis/compiler` — `tileKey`, `tileKeyUnpack`, `compileSingleTile`, `decomposeFeatures`, `makeEvalProps`, `evaluate`, `packECEFPolygonVertices`, `GeoJSONFeature`, `GeometryPart`, `GeoJSONVTOptions`
- `../mvt-decoder` (data-local, #1001) — `decodeMvtTile` (pmtiles / virtual-pmtiles backends). Relocated from `@xgis/compiler`; pulls `@mapbox/vector-tile` + `pbf`.
- `proj4` — coordinate reprojection (`epsg-defs.ts`, `reproject-fc.ts`)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
