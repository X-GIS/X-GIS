<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# input

## Purpose
The decode side of the vector-tile pipeline: reads a single MVT (`.pbf`) tile and emits `GeoJSONFeature[]` with un-quantized lon/lat, ready to feed the existing `decomposeFeatures → compileSingleTile` path in `tiler/`. MVT geometry is tile-local integers in `[0, extent]`; the decoder un-quantizes via Web Mercator using `toGeoJSON(x, y, z)`, matching X-GIS tile addressing. This is the upstream that lets HTTP PMTiles / TileJSON sources flow through the same compile pipeline as in-memory GeoJSON.

## Key Files
| File | Description |
|------|-------------|
| `mvt-decoder.ts` | `decodeMvtTile(bytes, opts)` + `MvtDecodeOptions`. Parses MVT/PBF (via `@mapbox/vector-tile` + `pbf`) and returns un-quantized `GeoJSONFeature[]`. |

## For AI Agents

### Working In This Directory
- Output is the same `GeoJSONFeature[]` shape the GeoJSON path produces, so both upstreams converge on one decode+compile pipeline. Keep coordinate un-quantization aligned with the tiler's Web Mercator addressing (`tiler/vector-tiler.ts`).
- This is the only place that touches `pbf` / `@mapbox/vector-tile`; isolate raw-PBF handling here.

### Testing Requirements
- Colocated `mvt-decoder-fuzz.test.ts`; plus `src/__tests__/mvt-decoder.test.ts`. Run the fuzz test after touching the PBF parse path.

### Common Patterns
- `toGeoJSON(x,y,z)` for un-quantization; tile-local integer → lon/lat conversion mirrors the tiler.

## Dependencies

### Internal
- Imports `tiler/geojson-types`; output feeds `tiler/` (`decomposeFeatures`/`compileSingleTile`).

### External
- `@mapbox/vector-tile`, `pbf`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
