<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# sources

## Purpose
Per-format `TileSource` backend implementations consumed by `TileCatalog`. Each backend implements only the format-specific bits (fetch, decode, "do I have this key?"); cache/eviction/budget/sub-tile-gen stay on the catalog. The PMTiles and virtual (GeoJSON-derived) backends share an identical two-stage fetch→compile pipeline so GeoJSON sources inherit every PMTiles fix (paced compile, per-layer slices, extrude/stroke per-feature bakes) for free.

## Key Files
| File | Description |
|------|-------------|
| `pmtiles-backend.ts` | `PMTilesBackend` — two-stage: async HTTP byte-range fetch queues raw MVT bytes into `pendingMvt`, then `tick(budget)` per frame paces `decode → decompose → compile → sink`. Prevents 30+ stacked compiles blocking a frame. Holds `failedKeys`. |
| `virtual-pmtiles-backend.ts` | `VirtualPMTilesBackend` — serves GeoJSON-derived tiles through the same `TileSource` interface. Upstream = the GeoJSON tiling worker (geojsonvt → PBF); downstream half (`mvtPool.compile` + `acceptResult`) is byte-identical to PMTilesBackend. |
| `geojson-runtime-backend.ts` | `GeoJSONRuntimeBackend` — in-memory raw GeoJSON parts. Owns a spatial-grid index, synchronous `compileSingleTile` dispatch (find parts → compile → push via sink). |
| `virtual-catalog-adapter.ts` | Legacy back-compat adapter for the old `setVirtualCatalog` hook — fetcher returns a full `CompiledTile` and pushes immediately (no two-stage split). New code uses `PMTilesBackend` directly. |

## For AI Agents

### Working In This Directory
- Result delivery is push-based via `TileSourceSink.acceptResult`, never promise-return. Keep batch backends free to fan out as they decode.
- The PMTiles two-stage split (fetch queue + per-frame `tick` budget) is the fix for main-thread compile stalls — do not collapse fetch and compile back into one `.then`.
- Virtual and PMTiles backends must keep their downstream compile half identical so GeoJSON inherits PMTiles fixes; change shared logic in one place.

### Testing Requirements
- `pmtiles-backend.test.ts`, `geojson-runtime-backend.test.ts`, `virtual-catalog-fetch.test.ts`. Cover failure caching (`failedKeys` → offline fallback) and budget pacing for new fetch logic.

### Common Patterns
- Two-stage fetch/compile with per-frame `tick(budget)`. Per-MVT-layer slices keyed `(key, layerName)`. Silent failure caching so a missed range marks the key failed once.

## Dependencies

### Internal
- `../tile-source`, `../tile-types`, `../workers/*` (mvt + geojson tiling pools), `@xgis/compiler` (`tileKeyUnpack`, `compileSingleTile`, decode).

### External
- `pmtiles`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
