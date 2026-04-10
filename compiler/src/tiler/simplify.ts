// ═══ Douglas-Peucker Line Simplification ═══
// Reduces vertex count while preserving shape.
// Zero dependencies — pure math implementation.

/**
 * Simplify a ring/polyline using Douglas-Peucker algorithm.
 * @param ring Array of [lon, lat] coordinate pairs
 * @param tolerance Maximum allowed deviation in degrees
 * @returns Simplified coordinate array (always preserves first and last point)
 */
export function simplify(ring: number[][], tolerance: number): number[][] {
  if (ring.length <= 2) return ring
  if (tolerance <= 0) return ring

  const sqTolerance = tolerance * tolerance
  const keep = new Uint8Array(ring.length)
  keep[0] = 1
  keep[ring.length - 1] = 1

  dpStep(ring, 0, ring.length - 1, sqTolerance, keep)

  const result: number[][] = []
  for (let i = 0; i < ring.length; i++) {
    if (keep[i]) result.push(ring[i])
  }

  return result
}

/** Recursive Douglas-Peucker step */
function dpStep(
  ring: number[][],
  first: number,
  last: number,
  sqTolerance: number,
  keep: Uint8Array,
): void {
  let maxDist = 0
  let maxIdx = first

  for (let i = first + 1; i < last; i++) {
    const dist = sqDistToSegment(ring[i], ring[first], ring[last])
    if (dist > maxDist) {
      maxDist = dist
      maxIdx = i
    }
  }

  if (maxDist > sqTolerance) {
    keep[maxIdx] = 1
    if (maxIdx - first > 1) dpStep(ring, first, maxIdx, sqTolerance, keep)
    if (last - maxIdx > 1) dpStep(ring, maxIdx, last, sqTolerance, keep)
  }
}

/** Squared distance from point p to line segment a-b */
function sqDistToSegment(p: number[], a: number[], b: number[]): number {
  let x = a[0], y = a[1]
  let dx = b[0] - x, dy = b[1] - y

  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) {
      x = b[0]
      y = b[1]
    } else if (t > 0) {
      x += dx * t
      y += dy * t
    }
  }

  dx = p[0] - x
  dy = p[1] - y
  return dx * dx + dy * dy
}

/**
 * Get simplification tolerance for a given zoom level.
 * Higher zoom = lower tolerance = more detail.
 */
export function toleranceForZoom(zoom: number): number {
  // At zoom 0, ~1° tolerance (very coarse)
  // At zoom 14, ~0.0001° tolerance (~11m)
  // Each zoom level halves the tolerance
  return 1.0 / Math.pow(2, zoom)
}

/**
 * Simplify a polygon (outer ring + holes) for a given zoom level.
 * Preserves ring closure and minimum vertex count.
 */
export function simplifyPolygon(rings: number[][][], zoom: number): number[][][] {
  const tolerance = toleranceForZoom(zoom)
  return rings
    .map(ring => simplify(ring, tolerance))
    .filter(ring => ring.length >= 3) // discard degenerate rings
}

/**
 * Simplify a linestring for a given zoom level.
 */
export function simplifyLine(coords: number[][], zoom: number): number[][] {
  const tolerance = toleranceForZoom(zoom)
  const result = simplify(coords, tolerance)
  return result.length >= 2 ? result : coords // preserve at least 2 points
}
