<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-03 -->

# loader

## Purpose

This directory is the data-ingestion layer for the X-GIS runtime. It converts external map data into GPU-ready mesh buffers and manages vector tile source lifecycle. There are three distinct concerns: (1) GeoJSON tessellation — earcut-based polygon triangulation + great-circle subdivision into `Float32Array` vertex/index buffers ready for upload to the GPU arena; (2) vector tile source management — a class hierarchy (`VectorTileLoader` / `PMTilesArchiveSource` / `TileJSONSource`) that opens PMTiles archives and TileJSON manifests, enforces SSRF + size-bomb guards on every remote fetch, and wires each source into `TileCatalog` via `PMTilesBackend`; (3) tile selection — a Cesium-style screen-space-error DFS selector (`visibleTilesSSE`) that replaces the legacy frustum selector and drives pitch-aware LOD with world-copy support, horizon culling, and fallback-parent injection. A fourth building block, `polar-cap-detect.ts`, synthesises cap geometry for globe projections where Mercator-clamped polygons leave a hole at ±85°.

## Key Files

| File | Description |
|------|-------------|
| `geojson.ts` | Public entry point for GeoJSON → GPU mesh conversion. `loadGeoJSON` tessellates a `GeoJSONFeatureCollection` (Polygon/MultiPolygon/LineString/MultiLineString/GeometryCollection) into `MeshData` + `LineMeshData`. Polygons use earcut + post-earcut great-circle tri-subdivision (max depth 5, threshold `MAX_TRI_DEGREES=2°`); lines accumulate Mercator arc-length per vertex (stride 4: lon/lat/feat_id/arc). Anti-meridian split and wide-polygon Sutherland-Hodgman clip delegated to `geojson-helpers`. Re-exports public types and `lonLatToMercator` for back-compat. |
| `geojson-helpers.ts` | Pure geometry helpers: `lonLatToMercator`, `subdivideRing` (great-circle midpoint insertion at >3° edges), `splitWidePolygon` (Sutherland-Hodgman clip at 20° intervals with anti-meridian shift), `splitLineAtAntiMeridian`. Shared subdivision constants `MAX_EDGE_DEGREES=3`, `MAX_TRI_DEGREES=2`. No module-level state. |
| `geojson-types.ts` | Type definitions for the GeoJSON → GPU pipeline: `GeoJSONFeatureCollection`, `GeoJSONFeature`, `GeoJSONGeometry` (union including `GeometryCollection`), `MeshData` (stride-3 polygon vertex layout: lon/lat/feat_id), `LineMeshData` (stride-4: lon/lat/feat_id/arc), `FeatureRange`. |
| `vector-tile-loader.ts` | Orchestrates PMTiles + TileJSON sources. `VectorTileLoader` owns memoized archive/manifest caches; `PMTilesArchiveSource` and `TileJSONSource` are format-specific subclasses of `VectorTileSource`. `fetchTileWithRetry` implements 3-attempt exponential backoff (300 ms / 900 ms), per-URL negative cache (5 min TTL), SSRF guard via `assertSafeRemoteUrl`, Content-Length fast-reject, and `readBodyCapped` streaming cap (8 MB tiles; 4 MB TileJSON). Default singleton + back-compat function wrappers (`attachPMTilesSource`, `loadPMTilesSource`, `prewarmVectorTileSource`, etc.). |
| `vector-tile-loader-helpers.ts` | Pure helpers: `detectVectorTileFormat` (URL extension + `kind` override, case-insensitive, strips `pmtiles://` scheme, handles `.mvt`/`.pbf`/XYZ templates with `{z}/{x}/{y}`), `resolveDispatch` (deprecated back-compat shim), `memoizeOpen` (concurrent-dedup + rejection-eviction promise cache), `normalizeVectorLayers`. |
| `vector-tile-loader-types.ts` | Type declarations: `VectorLayerInfo`, `VectorTileFormat`, `PMTilesSourceOptions`, `ResolvedSource`, `CachedArchive`, `CachedTileJSON`, `RawTileJSON`. |
| `tiles-sse.ts` | Screen-space-error tile selector. `visibleTilesSSE` runs a DFS over the Mercator quadtree using the Cesium SSE formula (`geometricError × canvasHeight / distance / 2 / tanHalfFov`). Pitch-adaptive target ramps from 1 px at pitch≤60° toward 24 px at pitch=80°+zoom>17. Globe-equivalent horizon cull (1.2× `√(2Rh)`), world-copy enumeration, sub-pixel AABB cull (<4 px²), fallback-parent inject (depth 2). Module-level scratch Set avoids per-frame allocation. |
| `polar-cap-detect.ts` | Polar-cap geometry injector for raw GeoJSON sources. `injectPolarCaps` scans a `FeatureCollection` for polygon outer rings touching the ±85.051° Mercator clamp boundary, synthesises a subdivided cap ring (`synthesizeCapRing`, default 16 subdivisions) closing the surface to ±90°, and appends the cap features with the source feature's properties. `findClampBoundarySpans` + `vertexOnClampBoundary` are the detection primitives. |

## For AI Agents

### Working In This Directory

- **SSRF guard is mandatory on every remote URL.** All fetch paths call `assertSafeRemoteUrl` (from `../engine/safety`) before any network access. Adding a new fetch without this guard will be rejected in review.
- **Body-cap all remote responses.** Use `readBodyCapped` for streaming bodies; check `Content-Length` as a fast-path first. Constants are `MAX_TILE_BYTES = 8 MB` and `MAX_TILEJSON_BYTES = 4 MB`. The PMTiles decompression-bomb guard is a separate post-`getZxy` byte check — both paths are needed.
- **GeoJSON vertex layout is stride-3 (lon/lat/feat_id) for polygons and stride-4 (lon/lat/feat_id/arc) for lines.** Changing either stride breaks the GPU buffer layout consumed by the vector-tile renderer. Any stride change must propagate to the renderer's `vertexBufferLayout` declarations.
- **`detectVectorTileFormat` is the single routing authority.** Do not add URL-sniffing logic elsewhere. URL extension wins over the `kind` hint — this precedence rule prevents "Wrong magic number" crashes when a host rewrites `.pmtiles` to `.json` on the server.
- **`memoizeOpen` evicts on rejection.** Intentional — a failed archive open allows retry. Do not cache failed promises.
- **`visibleTilesSSE` uses a module-level scratch Set** (`_injectedParentsScratch`) for zero-allocation parent dedup. It is cleared at function entry and is safe only because the render loop calls it synchronously. Do not make this function async.
- **earcut runs on Mercator-projected coordinates**, not lon/lat. `tessellatePolygonPart` projects via the lat-clamp before passing to earcut. Great-circle subdivision happens post-earcut on the finalised indices. Keep this order.
- **Anti-meridian handling is two-layer**: `splitWidePolygon` handles polygon rings (Sutherland-Hodgman at 20° strips); `splitLineAtAntiMeridian` handles polylines (crossing detection + interpolated cut vertex). Both must be kept in sync if coordinate-shift logic changes.
- **Polar cap synthesis applies to raw GeoJSON only.** Pre-tiled MVT takes the `data/polar-cap-synth.ts` code path instead — different entry point, same geometric goal.

### Testing Requirements

- Unit tests alongside source: `polar-cap-detect.test.ts` (span detection, ring synthesis, wrap-around), `tiles-sse.test.ts` (SSE formula, world-copy, pitch ramp, fallback-parent), `geojson-geometry-collection.test.ts` (GeometryCollection one-level flatten). Run via `vitest` from `runtime/`.
- These tests are CPU-only — no GPU or canvas required.
- Visual correctness of tessellated geometry (antimeridian seams, wide-polygon earcut edges) is gated by the render-verification harness (`feat/render-verification-harness`) and the pixel-match oracle, not unit tests. Do not rely on unit tests alone for polygon edge correctness.
- `geojson.d.ts` and `geojson.js.map` are build artefacts — do not edit by hand.

### Common Patterns

- Files are split into `*-types.ts` (pure types), `*-helpers.ts` (pure stateless functions), and a main `*.ts` (orchestration + classes + back-compat re-exports). New logic should follow this split.
- Back-compat re-exports sit at the bottom of the main module with a comment identifying which prior import paths they preserve.
- Internal thresholds and cache TTL constants are declared at module scope with explanatory comments. No inlined magic numbers.
- `xlog.warn` / `xlog.error` (from `../engine/log`) for engine diagnostics; `console.log` is used only for attach/attribution info messages that mirror MapLibre's style.

## Dependencies

### Internal

- `../engine/safety` — `assertSafeRemoteUrl`, `readBodyCapped`, `assertIngestBudget`
- `../engine/log` — `xlog`
- `../engine/projection/projection` — `MERCATOR_LAT_LIMIT`, `mercatorYToLat`
- `../engine/gpu/gpu-shared` — `worldCopiesFor`, `TILE_PX`
- `../data/tile-catalog` — `TileCatalog` (attach target for vector sources)
- `../data/sources/pmtiles-backend` — `PMTilesBackend`, `PMTilesFetcher`
- `../data/tile-select` — `TileCoord` type consumed by `visibleTilesSSE`
- `@xgis/compiler/tiler/geodesic` — `interpolateGreatCircle`

### External

- `pmtiles` — `PMTiles`, `TileType`, `Header` (byte-range streaming archive reader)
- `earcut` — 2D polygon triangulation

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
