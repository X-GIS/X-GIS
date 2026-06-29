// ═══ `distance` geometry-proximity predicate (CPU, GPU-free) ═══
//
// Mapbox `["distance", <GeoJSON>]` returns the shortest distance in METRES
// between the current feature's geometry and the argument geometry. Pure
// CPU — no GPU, no rendering — so it is verifiable by unit tests alone.
//
// The converter (convert/expr-lookup.ts `distanceHandler`) decomposes the
// constant target GeoJSON at COMPILE time into three flat primitive sets —
// points, segments, and polygon ring-sets — and lowers the expression to
//   distance(get("$geometry"), <points>, <segments>, <polygons>)
// callBuiltin('distance', …) then calls evalDistance here.
//
// Metric: cheap-ruler (latitude-corrected planar) — the same approximation
// Mapbox/`@mapbox/cheap-ruler` use; accurate to ~0.1% for the sub-regional
// distances proximity filters care about, with none of the spherical
// cross-track edge cases.
//
// FIRST SLICE — Point / MultiPoint feature-geometry (the dominant
// proximity-filter case). LineString / Polygon feature-geometry and
// MVT tile-coordinate sources return null (deferred); spec-coverage
// marks the property `partial`.

type Pt = readonly number[]
type Points = ReadonlyArray<Pt>
type Segments = ReadonlyArray<ReadonlyArray<Pt>>
type Polygons = ReadonlyArray<ReadonlyArray<ReadonlyArray<Pt>>>

const RAD = Math.PI / 180

/** Metres-per-degree (lng, lat) at `lat` — cheap-ruler series. */
function rulerFactors(lat: number): [number, number] {
  const cos = Math.cos(lat * RAD)
  const cos2 = 2 * cos * cos - 1
  const cos3 = 2 * cos * cos2 - cos
  const cos4 = 2 * cos * cos3 - cos2
  const cos5 = 2 * cos * cos4 - cos3
  const kx = 1000 * (111.41513 * cos - 0.09455 * cos3 + 0.00012 * cos5)
  const ky = 1000 * (111.13209 - 0.56605 * cos2 + 0.0012 * cos4)
  return [kx, ky]
}

/** Planar distance from point (0,0) to segment a→b, in projected metres. */
function distToSegment(ax: number, ay: number, bx: number, by: number): number {
  let dx = bx - ax
  let dy = by - ay
  if (dx !== 0 || dy !== 0) {
    const t = (-ax * dx + -ay * dy) / (dx * dx + dy * dy)
    if (t > 1) { ax = bx; ay = by }
    else if (t > 0) { ax += dx * t; ay += dy * t }
  }
  dx = -ax
  dy = -ay
  return Math.hypot(dx, dy)
}

/** Even-odd containment of (x, y) in any polygon (outer + holes per poly). */
function pointInPolygons(x: number, y: number, polygons: Polygons): boolean {
  for (const polygon of polygons) {
    let inside = false
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i]![0]!, yi = ring[i]![1]!
        const xj = ring[j]![0]!, yj = ring[j]![1]!
        if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
      }
    }
    if (inside) return true
  }
  return false
}

/** Shortest distance (metres) from feature point p to the target sets. */
function pointToTarget(p: Pt, points: Points, segments: Segments, polygons: Polygons): number {
  const plng = Number(p[0]), plat = Number(p[1])
  if (polygons.length > 0 && pointInPolygons(plng, plat, polygons)) return 0
  const [kx, ky] = rulerFactors(plat)
  let best = Infinity
  for (const q of points) {
    const dx = (Number(q[0]) - plng) * kx
    const dy = (Number(q[1]) - plat) * ky
    const d = Math.hypot(dx, dy)
    if (d < best) best = d
  }
  for (const seg of segments) {
    const a = seg[0]!, b = seg[1]!
    const d = distToSegment(
      (Number(a[0]) - plng) * kx, (Number(a[1]) - plat) * ky,
      (Number(b[0]) - plng) * kx, (Number(b[1]) - plat) * ky,
    )
    if (d < best) best = d
  }
  return best
}

/** Reduce a feature geometry to its points. Point/MultiPoint only — other
 *  types are deferred (return null so the caller degrades to null). */
function featurePoints(geometry: unknown): Points | null {
  if (!geometry || typeof geometry !== 'object') return null
  const { type, coordinates } = geometry as { type?: unknown; coordinates?: unknown }
  if (type === 'Point') {
    return Array.isArray(coordinates) && coordinates.length >= 2 ? [coordinates as Pt] : null
  }
  if (type === 'MultiPoint') {
    return Array.isArray(coordinates) ? (coordinates as Points) : null
  }
  return null
}

/** Evaluate `distance`: shortest metres between `geometry` and the target.
 *  Returns null for unsupported feature-geometry or an empty target (fail
 *  closed — a null in a numeric comparison rejects the feature). */
export function evalDistance(
  geometry: unknown,
  points: unknown,
  segments: unknown,
  polygons: unknown,
): number | null {
  const pts = featurePoints(geometry)
  if (pts === null || pts.length === 0) return null
  const P = (Array.isArray(points) ? points : []) as Points
  const S = (Array.isArray(segments) ? segments : []) as Segments
  const G = (Array.isArray(polygons) ? polygons : []) as Polygons
  if (P.length === 0 && S.length === 0 && G.length === 0) return null
  let best = Infinity
  for (const p of pts) {
    if (!Array.isArray(p) || p.length < 2) continue
    const d = pointToTarget(p, P, S, G)
    if (d < best) best = d
  }
  return Number.isFinite(best) ? best : null
}
