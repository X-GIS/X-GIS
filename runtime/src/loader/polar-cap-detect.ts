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
    if (sides[k] === 0) { firstZero = k; break }
  }
  if (firstZero === -1) {
    // Whole ring on the boundary — entire ring is one span.
    const pole = sides[0]! as -1 | 1
    return [{
      pole,
      startIdx: 0,
      endIdx: n - 1,
      startLon: ring[0]![0],
      endLon: ring[n - 1]![0],
    }]
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
