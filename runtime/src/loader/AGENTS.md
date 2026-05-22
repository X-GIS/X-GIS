<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# loader

## Purpose
Input ingestion + screen-space tile selection. `geojson.ts` parses GeoJSON into meshes (lon/lat → Mercator, earcut fill, great-circle densified lines) and is the home of `lonLatToMercator`. `vector-tile-loader.ts` is the class-based PMTiles/TileJSON orchestrator (archive + manifest caches, attach, prewarm, schema fetch). `tiles-sse.ts` is the screen-space-error tile selector (Cesium/3D-Tiles convention) that replaces pixel-tile-size LOD — the latter over-selects foreshortened horizon tiles at high pitch. `polar-cap-detect.ts` stitches cap rings for raw GeoJSON polygons clamped at the Mercator latitude limit.

## Key Files
| File | Description |
|------|-------------|
| `geojson.ts` | GeoJSON parse → `MeshData`/`LineMeshData` (earcut fill, great-circle line densification), `lonLatToMercator`, geometry-collection handling. |
| `vector-tile-loader.ts` | `VectorTileLoader` orchestrator + `VectorTileSource` base + `PMTilesArchiveSource` / `TileJSONSource`; archive/manifest caches, attach + prewarm + `fetchVectorLayerSchema`. |
| `tiles-sse.ts` | Screen-space-error tile selector — pitch-aware LOD that fixes high-pitch over-selection (the "300-slot budget doesn't understand foreshortening" class). |
| `polar-cap-detect.ts` | For raw GeoJSON: walks polygons touching the ±MERCATOR_LAT_LIMIT clamp boundary and synthesizes a cap ring (`injectPolarCaps`, `findClampBoundarySpans`, `synthesizeCapRing`). |

## For AI Agents

### Working In This Directory
- **Tile selection is a known bug-prone area.** `tiles-sse.ts` is the SSE selector; `data/tile-select.ts` holds the frustum selector. They feed the same budget — changing pitch/SSE thresholds shifts visible tile counts. Gate on e2e tile counts + p95/max ms vs a mercator control.
- earcut runs in Mercator-projected coordinates (so edges match the GPU) — `geojson.ts` projects BEFORE triangulating. Don't triangulate in lon/lat.
- Lines are densified along great circles so they curve correctly under non-Mercator projections.
- Polar caps: `polar-cap-detect.ts` handles raw GeoJSON (coords still on the boundary); pre-tiled MVT goes through `data/polar-cap-synth.ts` instead — different code path, same goal.

### Testing Requirements
- `tiles-sse.test.ts`, `geojson-geometry-collection.test.ts`, `polar-cap-detect.test.ts`. Cover pitch + DPR tile-count regressions for selector changes and ±90° rings for cap changes.

### Common Patterns
- Project-then-triangulate. Great-circle densified lines. Class-based loader with format-specific `VectorTileSource` subclasses + caches.

## Dependencies

### Internal
- `@xgis/compiler` (`tiler/geodesic` great-circle, tile keys), `engine/gpu/gpu-shared` (`worldCopiesFor`, `TILE_PX`), `engine/projection`.

### External
- `earcut`, `pmtiles`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
