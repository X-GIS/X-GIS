// ═══ `within` geometry-containment predicate (CPU, GPU-free) ═══
//
// Mapbox `["within", <GeoJSON Polygon|MultiPolygon>]` filter: true when
// the CURRENT feature's geometry is fully contained inside the argument
// polygon(s). This is a pure CPU predicate — no GPU, no rendering — so it
// is verifiable entirely by unit tests (within.test.ts).
//
// The converter (convert/expr-lookup.ts `withinHandler`) lowers the
// expression to `within(get("$geometry"), <coords>)`, where:
//   * `$geometry` is the feature geometry object the runtime injects into
//     the evaluator props bag (reserved-keys.ts GEOMETRY_KEY), and
//   * `<coords>` is the argument polygon normalised to MultiPolygon form
//     and emitted as a nested array literal.
// callBuiltin('within', [geometry, polygons]) then calls evalWithin here.
//
// FIRST SLICE — Point / MultiPoint tested-geometry only, against a
// Polygon / MultiPolygon argument (holes honoured). LineString / Polygon
// tested-geometry and MVT-source tile-coordinate reprojection are deferred
// (return false); spec-coverage marks the property `partial` accordingly.

/** A linear ring: a list of [x, y] vertices. */
type Ring = ReadonlyArray<ReadonlyArray<number>>
/** A polygon: outer ring followed by zero or more hole rings. */
type PolygonCoords = ReadonlyArray<Ring>
/** A MultiPolygon: a list of polygons. */
type Polygons = ReadonlyArray<PolygonCoords>

/** Even-odd ray cast of point (x, y) against ALL rings of one polygon.
 *  Counting crossings over outer + hole rings together makes holes fall
 *  out for free: a point inside the outer ring AND inside a hole crosses
 *  both → even → outside; inside outer but not the hole → odd → inside. */
function pointInPolygon(x: number, y: number, polygon: PolygonCoords): boolean {
  let inside = false
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i]![0]!, yi = ring[i]![1]!
      const xj = ring[j]![0]!, yj = ring[j]![1]!
      const intersects = (yi > y) !== (yj > y)
        && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
      if (intersects) inside = !inside
    }
  }
  return inside
}

/** Point is within at least one polygon of the MultiPolygon. */
function pointInPolygons(x: number, y: number, polygons: Polygons): boolean {
  for (const polygon of polygons) {
    if (pointInPolygon(x, y, polygon)) return true
  }
  return false
}

/** Validate that `polygons` is a non-empty MultiPolygon-shaped nested
 *  array (`number[][][][]`). The converter always emits this shape, but
 *  the evaluator runs on host-supplied ASTs too — fail closed on garbage
 *  rather than throwing mid-filter. */
function isPolygons(v: unknown): v is Polygons {
  return Array.isArray(v) && v.length > 0
}

/** Evaluate `within`: is `geometry` fully contained in `polygons`?
 *  Returns false for any unsupported / malformed input (fail closed —
 *  mirrors the filter-eval throw-is-reject contract). */
export function evalWithin(geometry: unknown, polygons: unknown): boolean {
  if (!isPolygons(polygons)) return false
  if (!geometry || typeof geometry !== 'object') return false
  const { type, coordinates } = geometry as { type?: unknown; coordinates?: unknown }

  if (type === 'Point') {
    if (!Array.isArray(coordinates) || coordinates.length < 2) return false
    return pointInPolygons(Number(coordinates[0]), Number(coordinates[1]), polygons)
  }

  if (type === 'MultiPoint') {
    // `within` requires FULL containment: every point must be inside, and
    // an empty point set is not "contained" (matches Mapbox — there is no
    // geometry to be within).
    if (!Array.isArray(coordinates) || coordinates.length === 0) return false
    for (const c of coordinates) {
      if (!Array.isArray(c) || c.length < 2) return false
      if (!pointInPolygons(Number(c[0]), Number(c[1]), polygons)) return false
    }
    return true
  }

  // LineString / MultiLineString / Polygon tested-geometry: deferred to a
  // follow-up slice (needs segment-vs-ring intersection). Fail closed.
  return false
}
