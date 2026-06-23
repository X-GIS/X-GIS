<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-23 -->

# input

## Purpose
Decode side of the vector-tile pipeline: reads a single MVT (`.pbf`) tile and emits `GeoJSONFeature[]` with un-quantized lon/lat coordinates, ready to feed into the `decomposeFeatures → compileSingleTile` path in `tiler/`. MVT geometry is tile-local integers in `[0, extent]`; `toGeoJSON(x, y, z)` un-quantizes via Web Mercator to match X-GIS tile addressing. Multi-layer MVTs are flattened to one feature array with the originating layer name stashed in `properties._layer`. This is the single upstream entry-point that lets HTTP PMTiles / TileJSON sources flow through the same compile pipeline as in-memory GeoJSON.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Barrel re-export: exports `decodeMvtTile` and `MvtDecodeOptions` from `mvt-decoder.ts`. |
| `mvt-decoder.ts` | `decodeMvtTile(buf, z, x, y, opts)` + `MvtDecodeOptions`. Parses MVT/PBF via `@mapbox/vector-tile` + `pbf`, un-quantizes all layers, merges into one `GeoJSONFeature[]`. Contains `clampGeometryToPlanet` which clamps every vertex to `[-180,180]` / `[-85.0511287, 85.0511287]` — critical NaN guard (iter-296): MVT buffer-zone vertices near antimeridian/poles un-quantize to out-of-range values that would poison f32 tile meshes downstream. |

No subdirectories exist in this directory.

## For AI Agents

### Working In This Directory
- `decodeMvtTile` signature takes `buf, z, x, y, opts` — note positional `z, x, y` separate from `opts`; the old shape used an `opts` object for coords, do not regress.
- `clampLon`/`clampLat` have an explicit `Number.isNaN` guard before the inequality comparisons; `NaN > MAX` is `false` so a naive ternary lets NaN fall through — the iter-296 regression pinned this. Never simplify this guard without re-running the fuzz suite.
- `_layer` injection in `properties` is the only way style code can distinguish layers from a multi-layer MVT; do not remove it.
- This is the only place in the codebase that imports `@mapbox/vector-tile` or `pbf`; keep raw-PBF handling isolated here.
- Output shape must stay compatible with `GeoJSONFeature` from `../tiler/geojson-types` — both the GeoJSON and MVT upstreams converge on the same compile path.

### Testing Requirements
- `mvt-decoder-fuzz.test.ts` (colocated): covers empty/garbage/all-zero buffers, `ArrayBuffer` vs `Uint8Array` input paths, and the iter-296 clamp contract (NaN→0, ±Infinity→bounds, out-of-range clamped, pathological spread). Run after any change to the decode or clamp path.
- Additional integration coverage lives in `compiler/src/__tests__/mvt-decoder.test.ts`.

### Common Patterns
- `f.toGeoJSON(x, y, z)` from `@mapbox/vector-tile` is the un-quantization call; tile-local integer → lon/lat mirrors the tiler's Web Mercator addressing.
- Layer iteration uses `Object.keys(tile.layers)` which preserves insertion order; layer filter is a `Set<string>` for O(1) lookup.

## Dependencies

### Internal
- `../tiler/geojson-types` — `GeoJSONFeature`, `GeoJSONGeometry` types; output feeds `tiler/` (`decomposeFeatures` / `compileSingleTile`).

### External
- `@mapbox/vector-tile` — MVT protobuf parsing and `toGeoJSON` un-quantization.
- `pbf` — low-level protobuf reader consumed by `VectorTile`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
