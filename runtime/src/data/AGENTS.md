<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# data

## Purpose
The tile data layer. `TileCatalog` is the router/cache that the vector-tile renderer talks to: it dispatches `(z, x, y)` requests to attached per-format `TileSource` backends (PMTiles, virtual-PMTiles-from-GeoJSON, in-memory GeoJSON), and owns the format-agnostic cross-cutting concerns — cache, LRU eviction, per-frame compile budget, sub-tile generation at over-zoom, and `onTileLoaded` fan-out. This dir also holds the CPU tile-selection algorithms (frustum + sampled), raster tile URL/loading helpers, polar-cap synthesis for pre-tiled MVT, and the filter/extrude expression evaluators that pre-bucket features at decode time. GPU-independent: it manages CPU arrays only — GPU upload is the renderer's job.

## Key Files
| File | Description |
|------|-------------|
| `tile-catalog.ts` | `TileCatalog` — routes requests to `TileSource` backends, manages cache/eviction/budget/sub-tile gen and the synthesised `XGVTIndex`. The surface VTR depends on. (Formerly `XGVTSource`.) |
| `tile-source.ts` | `TileSource` per-format backend protocol + `TileSourceSink` (push-based result delivery, so batched range-request backends can fan out as they decode). |
| `tile-types.ts` | Shared tile-lifecycle types (`TileData`, tile state machine modelled on 3DTilesRenderer). Pure type module so backends import without the catalog. |
| `tile-select.ts` | Raster/web-map tile loader + `firstIndexedAncestor` quad-tree walk (over-zoom fallback). `visibleTilesFrustum`, `tileUrl`, `loadImageTexture`. |
| `sub-tile-generator.ts` | At over-zoom past archive maxZoom, clips a parent tile's geometry into a sub-tile rectangle in tile-local Mercator meters, re-packing into the sub-tile's DSFUN frame for seamless joins. Pure wrt catalog state. |
| `polar-cap-synth.ts` | Synthesizes polar cap rings for PMTiles/TileJSON sources (pre-tiled MVT can't anchor a cap at the clamp boundary). `projectionNeedsPolarCaps`. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `eval/` | Filter / extrude / feature-id expression evaluators + slice keying (see `eval/AGENTS.md`). |
| `sources/` | Per-format `TileSource` backends: PMTiles, virtual-PMTiles, GeoJSON-runtime (see `sources/AGENTS.md`). |
| `workers/` | MVT + GeoJSON decode/compile/tiling Web Worker pools (see `workers/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- **Tile selection + budget is a known bug-prone area.** `tile-select.ts` (frustum), `loader/tiles-sse.ts` (SSE), the catalog cache, and the renderer's per-frame upload budget interact through implicit limits. The `firstIndexedAncestor` walk caps at zoom 22 (DSFUN ceiling); the over-zoom black-screen bug came from a 2-level cap here.
- Backends deliver via the push `TileSourceSink`, never promise-return — preserve that so batch fetchers keep their optimisation.
- Catalog is GPU-free. Do not introduce GPU types here; the renderer owns upload.

### Testing Requirements
- Dense suite: `tile-cross-path-invariants.test.ts` (two subsystems must agree), `tile-selection-{dpr,pitch,semantic}.test.ts`, `tile-high-pitch-coverage.test.ts`, `tile-sampled-algorithm.test.ts`, `first-indexed-ancestor.test.ts`, `polar-cap-synth.test.ts`, `sub-tile-generator.test.ts`. Add cross-path invariant coverage for any new selection/clip logic.
- Gate selection/budget changes on concrete e2e tile counts + p95/max ms vs a mercator control.

### Common Patterns
- Router/backend split: format-specific code in `TileSource`; format-agnostic state on the catalog.
- Sub-tile + cap geometry computed in tile-local Mercator meters, packed in DSFUN.

## Dependencies

### Internal
- `core/` (priority queue), `engine/gpu/gpu-shared` (`worldCopiesFor`, `TILE_PX`), `@xgis/compiler` (tile keys, `CompiledTile`, decode/compile).

### External
- `pmtiles`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
