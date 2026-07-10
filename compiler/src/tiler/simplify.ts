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
import { EARTH } from '@xgis/shared'

export function simplify(
  ring: number[][],
  tolerance: number,
  isLocked?: (coord: number[]) => boolean,
): number[][] {
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

/** Douglas-Peucker step (respects pre-locked vertices).
 *
 *  Explicit-stack iterative implementation — NOT recursive. A single ring
 *  in countries.geojson at low zoom carries tens of thousands of vertices,
 *  and the worst-case Douglas-Peucker descent depth is O(n) (a near-monotonic
 *  edge, or a long run of boundary-locked vertices, peels one point per level).
 *  The prior recursive form overflowed the JS native call stack
 *  (`RangeError: Maximum call stack size exceeded` in the tiler worker, every
 *  tile) on the `categorical` demo at z0. The heap-backed stack here has no
 *  such ceiling.
 *
 *  Behaviour is identical to the recursion: each [lo,hi] segment splits at its
 *  FIRST locked interior vertex (recursing the two sides, ignoring the distance
 *  test for that segment), otherwise at its max-deviation vertex when that
 *  deviation exceeds tolerance. The `keep[]` output is independent of segment
 *  processing order, so LIFO popping yields the same result as recursive descent. */
function dpStep(
  ring: number[][],
  first: number,
  last: number,
  sqTolerance: number,
  keep: Uint8Array,
): void {
  // Flat [lo, hi, lo, hi, ...] segment stack; push/pop pairs.
  const stack: number[] = [first, last]

  while (stack.length > 0) {
    const hi = stack.pop()!
    const lo = stack.pop()!

    let maxDist = 0
    let maxIdx = lo
    let hasLocked = false

    for (let i = lo + 1; i < hi; i++) {
      if (keep[i]) {
        // Locked vertex — split into sub-segments around it (the distance
        // test is skipped for this segment, as in the recursive form).
        hasLocked = true
        if (i - lo > 1) stack.push(lo, i)
        if (hi - i > 1) stack.push(i, hi)
        break
      }
      const dist = sqDistToSegment(ring[i], ring[lo], ring[hi])
      if (dist > maxDist) {
        maxDist = dist
        maxIdx = i
      }
    }

    if (hasLocked) continue

    if (maxDist > sqTolerance) {
      keep[maxIdx] = 1
      if (maxIdx - lo > 1) stack.push(lo, maxIdx)
      if (hi - maxIdx > 1) stack.push(maxIdx, hi)
    }
  }
}

/** Squared distance from point p to line segment a-b */
function sqDistToSegment(p: number[], a: number[], b: number[]): number {
  let x = a[0],
    y = a[1]
  let dx = b[0] - x,
    dy = b[1] - y

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
  // Tolerance = ~1/16 pixel at each zoom level.
  // At zoom z, one pixel ≈ 360/(TILE_PX*2^z) degrees with the
  // Mapbox / MapLibre 512-px convention (1/16 pixel = 360 / 8192).
  // Using 1/16 pixel keeps inter-feature gaps invisible even with
  // overzoom.
  return 360 / (8192 * Math.pow(2, zoom))
}

/**
 * Simplify a polygon (outer ring + holes) for a given zoom level.
 * Preserves ring closure and minimum vertex count.
 * @param isLocked Predicate to lock tile-boundary vertices from removal
 */
export function simplifyPolygon(
  rings: number[][][],
  zoom: number,
  isLocked?: (coord: number[]) => boolean,
  toleranceOverride?: number,
): number[][][] {
  // `toleranceOverride` is mandatory whenever rings are in Mercator
  // meters (industry-standard pipeline since 5ee001c). Pass
  // `mercatorToleranceForZoom(z)`. Omitting the override falls back
  // to the deg-based `toleranceForZoom(z)` which silently no-ops on
  // MM rings (deg tolerance ≈ 0.003 vs MM distances ~10^6).
  const tolerance = toleranceOverride ?? toleranceForZoom(zoom)
  // Holes (rings[1..]) are by definition INSIDE the outer — they
  // describe features at a strictly smaller scale (lakes, river
  // cutouts). The tolerance calibrated for the outer ring's scale
  // can collapse small holes to < 3 vertices, which then drops them
  // via the degenerate-filter — visible regression at demotiles
  // z=9 China (the Yangtze river hole gets simplified to nothing
  // and the country fill paints over the river).
  //
  // Fix: keep holes that survive simplification with >= 3 verts;
  // FALL BACK to the original unsimplified hole when simplification
  // collapses it. Outer ring keeps the strict `length >= 3` filter
  // (a collapsed outer means the polygon is degenerate at this zoom
  // and should be culled).
  const result: number[][][] = []
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i]!
    const simplified = simplify(ring, tolerance, isLocked)
    if (simplified.length >= 3) {
      result.push(simplified)
    } else if (i > 0 && ring.length >= 3) {
      // Hole — keep the unsimplified original rather than dropping.
      // Original is already small (that's why simplification killed
      // it); keeping it costs negligible extra triangulation work.
      result.push(ring)
    }
    // else: outer ring collapsed → polygon is degenerate, drop.
  }
  return result
}

/**
 * Simplify a linestring for a given zoom level.
 * @param isLocked Predicate to lock tile-boundary vertices from removal
 */
export function simplifyLine(
  coords: number[][],
  zoom: number,
  isLocked?: (coord: number[]) => boolean,
  toleranceOverride?: number,
): number[][] {
  const tolerance = toleranceOverride ?? toleranceForZoom(zoom)
  const result = simplify(coords, tolerance, isLocked)
  return result.length >= 2 ? result : coords // preserve at least 2 points
}

/** Tolerance in Mercator meters for line simplification (lines are clipped in Mercator). */
export function mercatorToleranceForZoom(zoom: number): number {
  // At zoom z, one pixel ≈ 2π * R / (TILE_PX * 2^z) meters with the
  // 512-px convention. Using 1/16 pixel to match toleranceForZoom's
  // ratio (1/16 * 512 = 32; 2πR/8192/2^z = 2πR / 32 / 256 / 2^z).
  return (2 * Math.PI * EARTH.sphereR) / (8192 * Math.pow(2, zoom))
}
