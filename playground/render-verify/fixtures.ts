// Deterministic synthetic geometry for the render-verification harness.
//
// EVERY coordinate is an explicit literal — no randomness, no Date, no
// network. The same FeatureCollections are pushed into X-GIS (via
// setSourceData on the fixture-render-verify.xgis sources) AND projected by
// d3-geo into the Oracle-B Canvas2D reference. Because both sides consume
// byte-identical input, any pixel diff is attributable to the render path,
// not the data.
//
// Geometry families (Oracle-B milestone-1, mercator):
//   GRATICULE — a 30° lon/lat grid (LineStrings). Stresses the projection's
//               line placement across the whole band.
//   POLYS     — filled squares at known places ([0,0], [100,40]). Stresses
//               fill rasterization + winding.
//   LINES     — polylines including ONE antimeridian crosser
//               ([170,10] → [-170,10]). Stresses world-wrap / seam suture.
//   POINTS    — a regular dot grid. Stresses point placement.
//
// All geometry is authored in the WGS84 lon/lat the runtime + d3 both expect.

export interface GeoJSONFeature {
  type: 'Feature'
  id?: number
  geometry:
    | { type: 'Point'; coordinates: [number, number] }
    | { type: 'LineString'; coordinates: [number, number][] }
    | { type: 'Polygon'; coordinates: [number, number][][] }
  properties: Record<string, unknown>
}

export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJSONFeature[]
}

// ─── GRATICULE: meridians + parallels every 30° ──────────────────────────
// Meridians run -150..150 (skip ±180 to avoid the seam in this base set);
// parallels run -60..60 (inside the Mercator band, away from the ±85° clamp).
// Each line is densified with explicit literal vertices so the projected
// curve is well-sampled on both the X-GIS and d3 sides.

const MERIDIAN_LONS = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150]
const PARALLEL_LATS = [-60, -30, 0, 30, 60]
// Explicit vertex latitudes/longitudes (every 15°) — literal, not generated
// at import time beyond this constant table walk (still fully deterministic).
const MERIDIAN_LAT_STOPS = [-60, -45, -30, -15, 0, 15, 30, 45, 60]
const PARALLEL_LON_STOPS = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150]

function graticule(): GeoJSONFeatureCollection {
  const features: GeoJSONFeature[] = []
  let id = 1
  for (const lon of MERIDIAN_LONS) {
    features.push({
      type: 'Feature',
      id: id++,
      geometry: {
        type: 'LineString',
        coordinates: MERIDIAN_LAT_STOPS.map((lat) => [lon, lat] as [number, number]),
      },
      properties: { kind: 'meridian', lon },
    })
  }
  for (const lat of PARALLEL_LATS) {
    features.push({
      type: 'Feature',
      id: id++,
      geometry: {
        type: 'LineString',
        coordinates: PARALLEL_LON_STOPS.map((lon) => [lon, lat] as [number, number]),
      },
      properties: { kind: 'parallel', lat },
    })
  }
  return { type: 'FeatureCollection', features }
}

// ─── POLYS: filled squares at known places ───────────────────────────────
// Closed rings (first == last). Two squares: one straddling the prime
// meridian/equator at [0,0], one at [100,40]. A third near [-60,-20] gives
// the fill a presence in the southern/western quadrant.

function square(cx: number, cy: number, half: number): [number, number][] {
  return [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
    [cx - half, cy - half],
  ]
}

function polys(): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 1, geometry: { type: 'Polygon', coordinates: [square(0, 0, 12)] }, properties: { name: 'origin' } },
      { type: 'Feature', id: 2, geometry: { type: 'Polygon', coordinates: [square(100, 40, 10)] }, properties: { name: 'east' } },
      { type: 'Feature', id: 3, geometry: { type: 'Polygon', coordinates: [square(-60, -20, 8)] }, properties: { name: 'southwest' } },
    ],
  }
}

// ─── LINES: polylines incl. ONE antimeridian crosser ─────────────────────
// L1 crosses the antimeridian ([170,10] → [-170,10]); the correct render
// wraps it as a continuous segment, NOT a full-width tear across the map.
// L2/L3 are ordinary diagonals to give the line layer non-seam content.

function lines(): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 1, geometry: { type: 'LineString', coordinates: [[170, 10], [-170, 10]] }, properties: { name: 'antimeridian-crosser' } },
      { type: 'Feature', id: 2, geometry: { type: 'LineString', coordinates: [[-120, 50], [-60, 20], [0, 50]] }, properties: { name: 'zigzag-north' } },
      { type: 'Feature', id: 3, geometry: { type: 'LineString', coordinates: [[20, -40], [60, -10], [120, -40]] }, properties: { name: 'zigzag-south' } },
    ],
  }
}

// ─── POINTS: a regular dot grid ──────────────────────────────────────────
// 7 lon × 5 lat dot grid, explicit literals. Avoids the ±85° clamp.

const POINT_LONS = [-120, -80, -40, 0, 40, 80, 120]
const POINT_LATS = [-60, -30, 0, 30, 60]

function points(): GeoJSONFeatureCollection {
  const features: GeoJSONFeature[] = []
  let id = 1
  for (const lat of POINT_LATS) {
    for (const lon of POINT_LONS) {
      features.push({
        type: 'Feature',
        id: id++,
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { lon, lat },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

export const GRATICULE: GeoJSONFeatureCollection = graticule()
export const POLYS: GeoJSONFeatureCollection = polys()
export const LINES: GeoJSONFeatureCollection = lines()
export const POINTS: GeoJSONFeatureCollection = points()

/** Source-id → FeatureCollection map, matching fixture-render-verify.xgis. */
export const FIXTURE_SOURCES: Record<string, GeoJSONFeatureCollection> = {
  graticule: GRATICULE,
  polys: POLYS,
  lines: LINES,
  points: POINTS,
}
