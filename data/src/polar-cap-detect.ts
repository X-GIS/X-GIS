// Polar-cap detector — first building block toward the source-side
// polygon preprocessor that synthesises the missing polar cap on
// globe / orthographic / azimuthal projections.
//
// Background: the Web Mercator tile scheme clamps polygon data at
// MERCATOR_LAT_LIMIT (±85.0511287798066°). Tiles contain no geometry
// for lat outside that band. Globe projects unclamped vertices, so
// polygons touching the clamp boundary leave a circular hole at the
// pole (lat ±85° to ±90° unfilled).
//
// The fix needs two passes:
//   1. Detect polygon rings that touch the clamp boundary.
//   2. Synthesise a cap ring that closes the surface from the
//      touching vertices to the pole.
//
// This module implements #1. The synthesis pass lands in a follow-up
// once the detector lands and accumulates coverage.

const MERCATOR_LAT_LIMIT = 85.0511287798066
const EPS = 0.001 // ~100 m of latitude — within tile quantisation.

/** A vertex sits on the Web Mercator clamp boundary when its
 *  latitude rounds to ±MERCATOR_LAT_LIMIT within EPS. Source data
 *  from Web Mercator tiles snaps to the clamp; non-tile sources
 *  with smaller epsilon need this tolerance to fire. */
export function vertexOnClampBoundary(lat: number): -1 | 0 | 1 {
  if (lat >= MERCATOR_LAT_LIMIT - EPS) return 1
  if (lat <= -MERCATOR_LAT_LIMIT + EPS) return -1
  return 0
}

/** Walk a polygon ring (array of [lon, lat] pairs) and return the
 *  contiguous spans of vertices sitting on the same pole's clamp
 *  boundary. Each span is a polar-cap candidate — the polygon ran
 *  along the boundary and is missing the cap geometry between the
 *  span endpoints and the pole.
 *
 *  Returns one entry per contiguous run; ring wrap-around is honoured
 *  (a span starting near the ring end + continuing at index 0 is
 *  reported as a single entry).
 *
 *  An empty result means the ring doesn't touch either pole's clamp
 *  boundary — no cap synthesis needed. */
export interface CapSpan {
  pole: -1 | 1
  startIdx: number
  endIdx: number
  /** Longitude of the first vertex in the span (used to anchor the
   *  synthesised cap polygon). */
  startLon: number
  /** Longitude of the last vertex in the span. */
  endLon: number
}

/** Minimal GeoJSON shapes the injector reads. The runtime's full
 *  GeoJSON types live elsewhere; we only need polygon-ish fields
 *  here, so we duck-type rather than importing the full hierarchy. */
type LonLat = [number, number]
interface PolygonGeometry {
  type: 'Polygon'
  coordinates: LonLat[][]
}
interface MultiPolygonGeometry {
  type: 'MultiPolygon'
  coordinates: LonLat[][][]
}
interface Feature {
  type: 'Feature'
  geometry: PolygonGeometry | MultiPolygonGeometry | { type: string; coordinates?: unknown } | null
  properties?: Record<string, unknown> | null
  id?: string | number
}
interface FeatureCollection {
  type: 'FeatureCollection'
  features: Feature[]
}

/** Scan a FeatureCollection for polygons touching the Web Mercator
 *  clamp boundary, synthesise a cap polygon for each detected span,
 *  and return a NEW FeatureCollection with the original features +
 *  the synthesised cap features appended.
 *
 *  Original features are pass-through references (no copy); the
 *  appended cap features carry the source feature's `properties`
 *  so style rules (e.g. fill-color match) apply to the cap fragment
 *  the same way they apply to the source polygon body.
 *
 *  Non-polygon geometries are passed through untouched. Idempotent:
 *  the cap features themselves don't sit on the boundary at the
 *  pole-side (the pole vertex is at lat ±90, not ±85), so a second
 *  pass adds nothing. */
export function injectPolarCaps(fc: FeatureCollection, subdivisions = 16): FeatureCollection {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    return fc
  }
  const capFeatures: Feature[] = []
  for (const feat of fc.features) {
    if (!feat || !feat.geometry) continue
    const polygons = polygonRingsOf(feat.geometry)
    if (polygons.length === 0) continue
    for (const ring of polygons) {
      const spans = findClampBoundarySpans(ring)
      for (const span of spans) {
        const capRing = synthesizeCapRing(span, subdivisions)
        capFeatures.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [capRing] },
          properties: feat.properties ?? {},
          id: typeof feat.id !== 'undefined' ? `${feat.id}__polar_cap_${span.pole}` : undefined,
        })
      }
    }
  }
  if (capFeatures.length === 0) return fc
  return {
    type: 'FeatureCollection',
    features: [...fc.features, ...capFeatures],
  }
}

function polygonRingsOf(g: NonNullable<Feature['geometry']>): LonLat[][] {
  // Only the OUTER ring (index 0) of each polygon contributes to
  // cap synthesis. Inner rings (holes) at the boundary represent
  // EXCLUDED areas — synthesising a cap for a hole would erroneously
  // fill the area the source polygon explicitly carved out.
  if (g.type === 'Polygon') {
    const coords = (g as PolygonGeometry).coordinates
    return coords.length > 0 && coords[0] ? [coords[0]] : []
  }
  if (g.type === 'MultiPolygon') {
    const out: LonLat[][] = []
    for (const poly of (g as MultiPolygonGeometry).coordinates) {
      if (poly.length > 0 && poly[0]) out.push(poly[0])
    }
    return out
  }
  return []
}

/** Synthesise a cap polygon ring that closes the surface from a
 *  CapSpan to the pole. Output is in lon/lat (degrees) ready for
 *  the existing source-data pipeline.
 *
 *  Geometry: trace the span at lat = ±MERCATOR_LAT_LIMIT from
 *  startLon to endLon, then run to the pole at lat = ±90°, then
 *  close the ring. Subdivides the boundary edge into N points so the
 *  globe projection (proj_globe) sees a smooth curved edge rather
 *  than a straight Mercator line in 3D.
 *
 *  Caller supplies the integer subdivision count (default 16); higher
 *  values smooth the boundary at the cost of vertex count. The output
 *  is a closed ring (last vertex equals first). */
export function synthesizeCapRing(span: CapSpan, subdivisions = 16): Array<[number, number]> {
  const boundaryLat = span.pole * MERCATOR_LAT_LIMIT
  const poleLat = span.pole * 90
  // Normalise span longitude range. Wrap-around when endLon < startLon
  // means the span crosses the antimeridian.
  let startLon = span.startLon
  let endLon = span.endLon
  if (endLon < startLon) endLon += 360
  const arc = endLon - startLon
  const out: Array<[number, number]> = []
  // Edge along the clamp boundary.
  for (let i = 0; i <= subdivisions; i++) {
    const t = i / subdivisions
    const lon = startLon + arc * t
    out.push([((lon + 540) % 360) - 180, boundaryLat])
  }
  // Single vertex at the pole. proj_globe collapses all longitudes
  // at ±90° to the same 3D point, so one vertex is enough; adding
  // more would create degenerate triangles.
  out.push([endLon - 360 * Math.floor((endLon + 180) / 360), poleLat])
  // Close.
  out.push(out[0]!)
  return out
}

export function findClampBoundarySpans(ring: Array<[number, number]>): CapSpan[] {
  if (ring.length < 2) return []
  const sides = ring.map(([, lat]) => vertexOnClampBoundary(lat))

  // Group contiguous runs of the same non-zero side. Wrap-around:
  // a run that starts before idx 0 and continues at idx 0 is merged.
  const out: CapSpan[] = []
  let i = 0
  // Find a "start" — a transition from 0 → ±1.
  const n = ring.length
  // Locate first non-boundary vertex to anchor wrap-around correctly.
  let firstZero = -1
  for (let k = 0; k < n; k++) {
    if (sides[k] === 0) {
      firstZero = k
      break
    }
  }
  if (firstZero === -1) {
    // Whole ring on the boundary — entire ring is one span.
    const pole = sides[0]! as -1 | 1
    return [
      {
        pole,
        startIdx: 0,
        endIdx: n - 1,
        startLon: ring[0]![0],
        endLon: ring[n - 1]![0],
      },
    ]
  }
  // Walk starting from the first zero so spans don't get split at the
  // arbitrary ring start.
  i = firstZero
  let visited = 0
  while (visited < n) {
    const idx = (i + visited) % n
    if (sides[idx] !== 0) {
      // Found span start.
      const pole = sides[idx]! as -1 | 1
      let len = 0
      while (len < n && sides[(idx + len) % n] === pole) len++
      out.push({
        pole,
        startIdx: idx,
        endIdx: (idx + len - 1) % n,
        startLon: ring[idx]![0],
        endLon: ring[(idx + len - 1) % n]![0],
      })
      visited += len
    } else {
      visited++
    }
  }
  return out
}
