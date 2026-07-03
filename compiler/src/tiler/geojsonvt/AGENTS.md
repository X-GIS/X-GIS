<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# tiler/geojsonvt

## Purpose

A 1:1 TypeScript port of mapbox/geojson-vt 4.0.2 (ISC license), bundled to avoid a runtime npm dependency. It builds an in-memory vector-tile index from a GeoJSON FeatureCollection: project to the [0,1] Web Mercator unit square, stamp Douglas-Peucker importance on each vertex, recursively split into 4-quad tiles, wrap features around the antimeridian, and transform to extent-local integer coordinates. It integrates with X-GIS conventions (Morton `tileKey` instead of geojson-vt's 32-bit pack) and adds an MVT/PBF encoder so tiled features can be emitted as standard Mapbox Vector Tile bytes.

## Key Files

| File            | Description                                                                                                                                                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`      | Public entry: `geojsonvt`, `GeoJSONVT`, `DEFAULT_OPTIONS`. The in-memory index — DP simplification + per-axis range clipping + iterative `splitTile` (stack-bounded), integrated with X-GIS `tileKey`. Defaults baked for 512-px MapLibre convention (extent=8192, buffer=2048, tolerance=6). |
| `convert.ts`    | Port of `convert.js` — FeatureCollection → projected intermediate (lat/lon → [0,1], importance stamping, closed-ring `FlatLine[]`).                                                                                                                                                           |
| `simplify.ts`   | Port of `simplify.js` — Douglas-Peucker writing per-vertex importance into the `z` slot of each coord triple.                                                                                                                                                                                 |
| `tile.ts`       | Port of `tile.js` — builds an internal tile, runs simplification, emits flat 2-coord-per-vertex output.                                                                                                                                                                                       |
| `clip.ts`       | Port of `clip.js` — clips features between two axis-parallel lines (the quad-split primitive).                                                                                                                                                                                                |
| `transform.ts`  | Port of `transform.js` — Mercator-projected space → `extent × extent` tile-local integers.                                                                                                                                                                                                    |
| `feature.ts`    | Port of `feature.js` — `createFeature` with bbox calculation.                                                                                                                                                                                                                                 |
| `wrap.ts`       | Port of `wrap.js` — antimeridian wrapping (clip left/right world-buffer copies, shift, merge).                                                                                                                                                                                                |
| `types.ts`      | Ported geojson-vt types (`GeoJSONVTOptions`, `TransformedTile`, `TransformedTileFeature`).                                                                                                                                                                                                    |
| `encode-mvt.ts` | X-GIS addition: `encodeMVT` — tiled features → MVT v2.1 PBF bytes (mirrors vt-pbf output). `MVTLayerInput`/`EncodeOptions`. Output is consumed by `compiler/src/input/mvt-decoder.ts` so GeoJSON and PMTiles paths converge on the same downstream pipeline.                                  |

## For AI Agents

### Working In This Directory

- These are **1:1 ports** — preserve the upstream algorithm shape and variable naming; the ISC license header / LICENSE provenance must stay. Don't "modernize" ported files casually.
- The single intentional divergence from upstream is tile addressing: Morton `tileKey` from `../vector-tiler.ts` (accurate to z=25) vs geojson-vt's `1<<z` 32-bit pack that wraps at z=31. `MAX_ALLOWED_ZOOM=25` is the hard ceiling in `index.ts`. Keep that integration documented at the call site.
- Upstream features deliberately dropped: cluster, lineMetrics, debug counters, tileCoords array — none feed the X-GIS render path.
- `encode-mvt.ts` is the only X-GIS-original file here; MVT-spec output behavior belongs there, not in ported files.

### Testing Requirements

- Colocated `geojsonvt.test.ts` and `encode-mvt.test.ts`. Validate encode output against the MVT spec (decoder round-trip), not against vt-pbf bytes directly.

### Common Patterns

- Each ported file banners "1:1 port of geojson-vt/src/<file>.js" with a short algorithm note. Coordinates carry a `z` importance slot through simplify, dropped after `tile.ts`.
- `splitTile` uses an iterative stack (not recursion) to keep call depth bounded at any zoom.

## Dependencies

### Internal

- `index.ts` uses `../vector-tiler.ts` (`tileKey`); re-exported via `compiler/src/index.ts`.
- `encode-mvt.ts` output consumed by `compiler/src/input/mvt-decoder.ts`.

### External

- `pbf` (encode-mvt only) — the sole runtime dependency here; the port itself replaces `geojson-vt`/`vt-pbf`, which remain dev-only references.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
