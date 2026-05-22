<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# tiler

## Purpose
The data-side of the compiler: compiles GeoJSON into a pyramid of GPU-ready vector tiles (COG-style overview levels) without any GPU dependency. It clips geometry to tile boundaries, simplifies rings via Douglas-Peucker, triangulates polygons (earcut, in Mercator-projected space so edges match GPU rendering), packs vertices into quantized / double-single-float (DSFUN) buffers, and emits per-part tiles (MultiPolygons split into individually-bounded parts to reduce tile scatter). Also provides great-circle geodesic densification, zigzag-delta-varint coordinate encoding, the tile-index data structures shared with the runtime catalog, and the Morton `tileKey` addressing scheme.

## Key Files
| File | Description |
|------|-------------|
| `vector-tiler.ts` | Core tiler. `compileGeoJSONToTiles(Async)`, `compileSingleTile`, `decomposeFeatures`, `tileKey`/`tileKeyParent`/`tileKeyChildren`, DSFUN + quantized vertex packing, line tessellation, arc augmentation, `lonLatToMercF64`/`splitF64`. Emits `CompiledTileSet`/`CompiledTile`. |
| `clip.ts` | Polygon + line clipping against axis-aligned rectangles (tile boundaries). Zero-dependency pure math: `clipPolygonToRect(V2)`, `clipLineToRect`. |
| `simplify.ts` | Douglas-Peucker simplification + zoom-tolerance helpers (`toleranceForZoom`, `mercatorToleranceForZoom`). |
| `geodesic.ts` | Great-circle (slerp) interpolation: `interpolateGreatCircle`, `haversineDistance`. Exposed as the `@xgis/compiler/tiler/geodesic` subpath export. |
| `encoding.ts` | ZigZag-delta-varint coordinate packing for compact tile storage; `RingPolygon` type. |
| `tile-format.ts` | Tile-index structures (`XGVTIndex`, `XGVTHeader`, `TileIndexEntry`, `TILE_FLAG_FULL_COVER`) shared with the runtime `TileCatalog`. The on-disk .xgvt container is gone — only the interface shapes remain. |
| `geojson-types.ts` | GeoJSON type defs duplicated from runtime to avoid a cross-package import. |
| `earcut.d.ts` | Local ambient declaration for `earcut`. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `geojsonvt/` | 1:1 TypeScript port of mapbox/geojson-vt + an MVT/PBF encoder (see `geojsonvt/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- earcut runs in **Mercator-projected** coordinates on purpose, so CPU triangle edges match GPU rendering. Do not triangulate in raw lat/lon.
- Tile addressing uses the Morton `tileKey()` here (accurate to z=25), distinct from geojson-vt's 32-bit pack. When two subsystems must agree on coordinates, see `docs/COORDINATES.md` and the cross-path invariant tests.
- This module is "military precision" sensitive (nautical/S100 edge cases) — avoid casual approximations; clipping/simplify changes are gated by fuzz + invariant tests.
- The .xgvt binary container was removed; `tile-format.ts` survives only as shared interface shapes. Don't reintroduce a serializer here.

### Testing Requirements
- Colocated fuzz/invariant suite: `clip.test.ts` + `clip-fuzz.test.ts`, `simplify-fuzz.test.ts`, `geodesic-fuzz.test.ts`, `tile-key-fuzz.test.ts`, `dsfun-precision-fuzz.test.ts`, `polygon-holes.test.ts`, `compile-tile-invariants.test.ts`. Plus `src/__tests__/tiler.test.ts`, `line-tiler.test.ts`, `ocean-holes-low-zoom.test.ts`, `korea-z7-clip-backtrack.test.ts`, country-boundary clip tests. Run fuzz tests after any geometry-math change.

### Common Patterns
- Zero-dependency pure-math files banner their algorithm. Coordinates flow lon/lat → Mercator F64 → quantized/DSFUN packing; F64 precision split via `splitF64` for GPU double-single emulation.

## Dependencies

### Internal
- Imports `geojsonvt/`, `eval/` (filter eval on features), `ir/` (paint shapes for compiled tiles). Re-exported broadly from `src/index.ts`.

### External
- `earcut` (triangulation).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
