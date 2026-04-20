# X-GIS coordinate-system convention

Last revised: 2026-04-20. Unified to MM-everywhere (industry standard).

This document defines which coordinate space each stage of the tile
pipeline operates in. Violating it is how the polygon-fill vs stroke
alignment bug (27 km divergence at z=8 boundary tiles) happened. New
contributors should read this before adding clipping, simplification,
or sub-tile logic.

**Industry reference**: this follows the Mapbox GL / MapLibre /
Tippecanoe convention of "project once to Mercator at source load,
all downstream tile work in Mercator." Source GeoJSON is projected
at `decomposeFeatures` time; the per-tile compile hot path never
touches lon/lat again except for the cheap bbox-reject.

## Spaces

| Code | Full name | Units | Used for |
|------|-----------|-------|----------|
| **LL** | WGS84 lon/lat | degrees | Source data, clipping, area calculations |
| **MM** | Global Web Mercator (EPSG:3857) | meters | Rendering, line arc length, DSFUN origin |
| **DLM** | DSFUN tile-local Mercator | meters, split f32 hi/lo | Output vertex format |
| **SP** | Screen / NDC | pixels / clip-space | Camera projection only |

Reference constants:
- Earth radius R = 6378137 m (EPSG:3857 spec)
- Mercator lat limit = 85.051129° (see `MERCATOR_LAT_LIMIT`)

## Convention: which space at which stage

| Stage | Space | Why |
|-------|-------|-----|
| GeoJSON input | **LL** | Source data from user — RFC 7946 lon/lat |
| `decomposeFeatures` (project once) | **LL → MM** | `makePolygonPart` calls `projectRingsToMM`; downstream sees MM only |
| Feature bbox (`part.minLon`, etc.) | **LL** | Kept in LL for cheap bbox-reject against tile bounds; O(1) |
| Polygon clipping (`clipPolygonToRect`) | **MM** | Matches render output space; edges straight in MM = how map renders |
| Polygon outline / stroke clipping | **MM** | Shares the MM-clipped ring set with fill — endpoints agree by construction |
| Line feature clipping (`clipLineToRect`) | **MM** | Arc length in meters; dash phase in meters |
| Simplify polygon (Douglas-Peucker) | **MM** | Tolerance via `mercatorToleranceForZoom` |
| Simplify line | **MM** | Same tolerance function |
| Sub-tile clip in `generateSubTile` | **MM** (parent-local) | Parent vertices are DSFUN (MM); clip bounds derived from LL tile bounds |
| Output vertices (polygon fill + outline + line + point) | **DLM** | f32 hi/lo pair, relative to tile origin (`tileMx`, `tileMy`) |
| Tile bounds query | **LL** (primary) + **MM** (derived via `lonLatToMercF64`) | Derive MM from LL, never the other way |

**Key simplification vs. pre-d34aed2/pre-2026-04-20**: polygons and
lines both clip/simplify in **MM**. No more "polygon=LL, line=MM"
split. This eliminates an entire class of space-mismatch bugs by
construction.

## Critical invariants

These must hold between sibling code paths:

1. **Polygon fill and stroke clip in the SAME space (MM).**
   Both walk the same MM-clipped ring set. Pre-d34aed2 the stroke
   used MM and the fill used LL, giving endpoints that diverged up
   to 27 km at boundary tiles. Now both are MM by construction.

2. **Fill triangulation boundary == stroke outline endpoints.**
   After clipping, the polygon fill's outer edge (boundary triangle
   edges) and the polygon outline's line endpoints must lie on the
   same (lon, lat) points within ε = 1 m in DLM units.

3. **`compileSingleTile(z, x, y)` and `compileGeoJSONToTiles`'s
   output at `(z, x, y)` produce geometrically equivalent tiles** for
   the same source. Batch and on-demand compilation are twins.

4. **Sub-tile area conservation**: for a parent tile P fully covered
   by feature F, the sum of triangle-areas in P's four DSFUN children
   (via `generateSubTile`) ≈ P's own triangle-area. Checked in
   tile-local MM (origin cancels).

5. **DSFUN reconstruction is exact (f64-equivalent)**: for any packed
   vertex `[h, ., l, .]`, `h + l` recovers the original f64 value
   within 1 µm in MM.

## Conversion direction rules

- **Always `LL → MM`, never `MM → LL`** inside the compile pipeline.
  The one exception: `tile-format.ts:105` decoding line data for
  compact storage needs `MM → LL` via `mercatorToInverse`.

- **Tile origin (`tileMx`, `tileMy`) derived from LL tile bounds**
  via `lonLatToMercF64(tb.west, tb.south)`. Never inverted.

- **Sub-tile clip bounds in `generateSubTile`** derived from LL sub-
  tile bounds, then re-originated to parent-local MM. The survey at
  2026-04-20 confirms this path does NOT exhibit the fill/stroke
  bug because parent vertices are already in MM — both fill and
  outline are clipped in the same (MM) space.

## Adding a new clip or simplify step

Checklist before merging:

1. Which space does your input live in? (trace back through the call stack)
2. Which space is your tolerance in? (degrees or meters)
3. Does the SIBLING path (fill vs stroke, line vs polygon-as-line,
   batch vs on-demand) use the same space? If not, why?
4. Add a cross-path invariant test in
   `runtime/src/__tests__/tile-cross-path-invariants.test.ts`.

The 2026-04-20 fill/stroke bug was invisible to unit tests because
each path was individually correct. It took comparing fill and stroke
OUTPUTS against each other to surface the divergence. Every new
clip/simplify step that produces "its own kind of output" deserves
a sibling comparison test.
