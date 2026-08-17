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
import { EARTH, mercatorToECEFSphere } from '@xgis/shared'

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

  dpStep(0, ring.length - 1, sqTolerance, keep, (i, lo, hi) =>
    sqDistToSegment(ring[i], ring[lo], ring[hi]),
  )

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
 *  processing order, so LIFO popping yields the same result as recursive descent.
 *
 *  `sqDist(i, lo, hi)` supplies the squared deviation of vertex `i` from the
 *  chord `lo`-`hi`. The walk owns no geometry of its own, so the SPACE the
 *  deviation is measured in is the caller's choice — the plane for rings
 *  (`simplify`), the plane OR the sphere for lines (`simplifyLineSphere`). */
function dpStep(
  first: number,
  last: number,
  sqTolerance: number,
  keep: Uint8Array,
  sqDist: (i: number, lo: number, hi: number) => number,
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
      const dist = sqDist(i, lo, hi)
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

/** Squared distance from vertex `i` to segment `lo`-`hi`, over a flat stride-3
 *  array of ECEF positions. 3D twin of `sqDistToSegment`; the flat array keeps
 *  the Douglas-Peucker inner loop allocation-free. */
function sqDistToSegment3(pts: Float64Array, i: number, lo: number, hi: number): number {
  const ax = pts[lo * 3],
    ay = pts[lo * 3 + 1],
    az = pts[lo * 3 + 2]
  let x = ax,
    y = ay,
    z = az
  let dx = pts[hi * 3] - ax,
    dy = pts[hi * 3 + 1] - ay,
    dz = pts[hi * 3 + 2] - az

  if (dx !== 0 || dy !== 0 || dz !== 0) {
    const t =
      ((pts[i * 3] - x) * dx + (pts[i * 3 + 1] - y) * dy + (pts[i * 3 + 2] - z) * dz) /
      (dx * dx + dy * dy + dz * dz)
    if (t > 1) {
      x = pts[hi * 3]
      y = pts[hi * 3 + 1]
      z = pts[hi * 3 + 2]
    } else if (t > 0) {
      x += dx * t
      y += dy * t
      z += dz * t
    }
  }

  dx = pts[i * 3] - x
  dy = pts[i * 3 + 1] - y
  dz = pts[i * 3 + 2] - z
  return dx * dx + dy * dy + dz * dz
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

/**
 * Simplify a line whose vertices are in MERCATOR METERS, keeping every vertex
 * that carries visible deviation in EITHER the render plane or on the sphere.
 *
 * Why the sphere test exists (#1522): Douglas-Peucker against a Mercator
 * tolerance is projection-blind, and a line of constant latitude is a STRAIGHT
 * LINE in Mercator. Every vertex a densified parallel carries is exactly
 * collinear there, so the planar test correctly discards all of them — and
 * under orthographic / globe / stereographic what survives is a chord across
 * the very curve those vertices were describing. Measuring the same deviation
 * on the sphere keeps them, projection-independently: one tolerance, decided
 * at tile-build time, with no camera dependency and no re-tiling when the
 * projection changes.
 *
 * The two tests are OR'd rather than swapped, so the PLANAR accuracy contract
 * is kept intact: Douglas-Peucker only stops splitting a run once every vertex
 * in it is within `tolerance` of the chord, and `tolerance` here bounds the
 * larger of the two deviations, so each dropped vertex is still within it in
 * the plane — plus, now, on the sphere. Swapping the metric outright would
 * have traded one blindness for another: Mercator meters are ground meters
 * over cos(lat), so a sphere-only tolerance is ~5.8× looser on the ground at
 * 80°N than what the render plane asks for there.
 *
 * (What OR'ing does NOT give is a superset of the retained VERTICES. A larger
 * deviation can move the argmax, and a different split point yields a
 * different recursion tree: measured over 4000 random polylines, 1465 kept
 * strictly more vertices and 51 individual vertices went the other way. The
 * per-vertex tolerance bound above is the invariant; the vertex set is not.)
 *
 * @param tolerance Deviation bound in meters (`mercatorToleranceForZoom`).
 *                  Both spaces are compared against it; they coincide at the
 *                  equator, where a Mercator meter IS a ground meter.
 * @param isLocked Predicate to lock tile-boundary vertices from removal
 */
export function simplifyLineSphere(
  coords: number[][],
  tolerance: number,
  isLocked?: (coord: number[]) => boolean,
): number[][] {
  if (coords.length <= 2) return coords
  if (tolerance <= 0) return coords

  const sqTolerance = tolerance * tolerance
  const keep = new Uint8Array(coords.length)
  keep[0] = 1
  keep[coords.length - 1] = 1
  if (isLocked) {
    for (let i = 0; i < coords.length; i++) {
      if (isLocked(coords[i])) keep[i] = 1
    }
  }

  // Unproject once per vertex, not once per distance test: Douglas-Peucker
  // evaluates O(n log n) segment distances but only ever needs these n
  // positions. EARTH is passed explicitly to stay on the same sphere radius
  // `mercatorToleranceForZoom` calibrates against.
  const ecef = new Float64Array(coords.length * 3)
  for (let i = 0; i < coords.length; i++) {
    const [x, y, z] = mercatorToECEFSphere(coords[i][0], coords[i][1], 0, EARTH)
    ecef[i * 3] = x
    ecef[i * 3 + 1] = y
    ecef[i * 3 + 2] = z
  }

  dpStep(0, coords.length - 1, sqTolerance, keep, (i, lo, hi) => {
    const planar = sqDistToSegment(coords[i], coords[lo], coords[hi])
    return Math.max(planar, sqDistToSegment3(ecef, i, lo, hi))
  })

  const result: number[][] = []
  for (let i = 0; i < coords.length; i++) {
    if (keep[i]) result.push(coords[i])
  }
  return result.length >= 2 ? result : coords // preserve at least 2 points
}

/** Tolerance in Mercator meters for line simplification (lines are clipped in Mercator). */
export function mercatorToleranceForZoom(zoom: number): number {
  // At zoom z, one pixel ≈ 2π * R / (TILE_PX * 2^z) meters with the
  // 512-px convention. Using 1/16 pixel to match toleranceForZoom's
  // ratio (1/16 * 512 = 32; 2πR/8192/2^z = 2πR / 32 / 256 / 2^z).
  return (2 * Math.PI * EARTH.sphereR) / (8192 * Math.pow(2, zoom))
}
