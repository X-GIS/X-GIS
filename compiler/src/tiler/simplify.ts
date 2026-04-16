// ═══ Douglas-Peucker Line Simplification ═══
// Reduces vertex count while preserving shape.
// Zero dependencies — pure math implementation.

/**
 * Simplify a ring/polyline using Douglas-Peucker algorithm.
 * @param ring Array of [lon, lat] coordinate pairs
 * @param tolerance Maximum allowed deviation in degrees
 * @param isLocked Optional predicate — locked vertices are never removed.
 *                 Used to preserve tile boundary vertices for seamless adjacency.
 * @returns Simplified coordinate array (always preserves first and last point)
 */
export function simplify(ring: number[][], tolerance: number, isLocked?: (coord: number[]) => boolean): number[][] {
  if (ring.length <= 2) return ring
  if (tolerance <= 0) return ring

  const sqTolerance = tolerance * tolerance
  const keep = new Uint8Array(ring.length)
  keep[0] = 1
  keep[ring.length - 1] = 1

  // Lock boundary vertices — they must survive simplification
  // so adjacent tiles share identical edge geometry
  if (isLocked) {
    for (let i = 0; i < ring.length; i++) {
      if (isLocked(ring[i])) keep[i] = 1
    }
  }

  dpStep(ring, 0, ring.length - 1, sqTolerance, keep)

  const result: number[][] = []
  for (let i = 0; i < ring.length; i++) {
    if (keep[i]) result.push(ring[i])
  }

  return result
}

/** Recursive Douglas-Peucker step (respects pre-locked vertices) */
function dpStep(
  ring: number[][],
  first: number,
  last: number,
  sqTolerance: number,
  keep: Uint8Array,
): void {
  // If a locked vertex exists between first..last, we must recurse through it
  // even if the max distance is below tolerance
  let maxDist = 0
  let maxIdx = first
  let hasLocked = false

  for (let i = first + 1; i < last; i++) {
    if (keep[i]) {
      // Locked vertex — recurse into sub-segments around it
      hasLocked = true
      if (i - first > 1) dpStep(ring, first, i, sqTolerance, keep)
      if (last - i > 1) dpStep(ring, i, last, sqTolerance, keep)
      return
    }
    const dist = sqDistToSegment(ring[i], ring[first], ring[last])
    if (dist > maxDist) {
      maxDist = dist
      maxIdx = i
    }
  }

  if (!hasLocked && maxDist > sqTolerance) {
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
  // Tolerance = ~1/16 pixel at each zoom level
  // At zoom z, one pixel ≈ 360/(256*2^z) degrees
  // Using 1/16 pixel ensures inter-feature gaps are invisible even with overzoom
  return 360 / (4096 * Math.pow(2, zoom))
}

/**
 * Simplify a polygon (outer ring + holes) for a given zoom level.
 * Preserves ring closure and minimum vertex count.
 * @param isLocked Predicate to lock tile-boundary vertices from removal
 */
export function simplifyPolygon(rings: number[][][], zoom: number, isLocked?: (coord: number[]) => boolean): number[][][] {
  const tolerance = toleranceForZoom(zoom)
  return rings
    .map(ring => simplify(ring, tolerance, isLocked))
    .filter(ring => ring.length >= 3) // discard degenerate rings
}

/**
 * Simplify a linestring for a given zoom level.
 * @param isLocked Predicate to lock tile-boundary vertices from removal
 */
export function simplifyLine(coords: number[][], zoom: number, isLocked?: (coord: number[]) => boolean, toleranceOverride?: number): number[][] {
  const tolerance = toleranceOverride ?? toleranceForZoom(zoom)
  const result = simplify(coords, tolerance, isLocked)
  return result.length >= 2 ? result : coords // preserve at least 2 points
}

/** Tolerance in Mercator meters for line simplification (lines are clipped in Mercator). */
export function mercatorToleranceForZoom(zoom: number): number {
  // At zoom z, one pixel ≈ 2π * R / (256 * 2^z) meters
  // Using 1/16 pixel to match toleranceForZoom's ratio
  return 2 * Math.PI * 6378137 / (4096 * Math.pow(2, zoom))
}
