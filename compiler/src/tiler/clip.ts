// ═══ Geometry Clipping ═══
// Polygon clipping + line segment clipping against axis-aligned
// rectangles (tile boundaries). Zero dependencies — pure math.
//
// Two clippers are exported:
//
//   - `clipPolygonToRect` (V1) — 4-pass Sutherland-Hodgman. Default
//     until V2 has been validated on every fixture path.
//   - `clipPolygonToRectV2` — 2-pass range-clip ported from
//     mapbox/geojson-vt. Each pass clips an entire ring against the
//     [min, max] range of one axis at a time; an edge that passes
//     through both bounds in one step generates intersection points
//     at BOTH boundaries. The V1 algorithm's per-half-plane approach
//     can produce subtly different output for non-convex inputs
//     with multiple boundary crossings — V2 mirrors the
//     battle-tested behaviour Mapbox GL / MapLibre rely on.
//
//   The two algorithms agree on every test in clip.test.ts; V2 is
//   under feature-flag rollout pending real-data validation (see
//   project_compiler_paint_shape_migration.md follow-ups for the
//   Yellow Sea repro 2026-05-12).

// ═══ Polygon Clipping V1: Sutherland-Hodgman ═══

/**
 * Clip polygon rings to an axis-aligned rectangle.
 * @param rings Array of rings: [outer, ...holes]. Each ring is [[lon,lat], ...]
 * @returns Clipped rings (empty array if entirely outside)
 */
export function clipPolygonToRect(
  rings: number[][][],
  west: number,
  south: number,
  east: number,
  north: number,
  precision?: number,
): number[][][] {
  const result: number[][][] = []

  for (const ring of rings) {
    let clipped = ring
    clipped = clipRingToEdge(clipped, west, 0, true, precision)   // keep lon >= west
    if (clipped.length < 3) continue
    clipped = clipRingToEdge(clipped, east, 0, false, precision)  // keep lon <= east
    if (clipped.length < 3) continue
    clipped = clipRingToEdge(clipped, south, 1, true, precision)  // keep lat >= south
    if (clipped.length < 3) continue
    clipped = clipRingToEdge(clipped, north, 1, false, precision) // keep lat <= north
    if (clipped.length < 3) continue
    result.push(clipped)
  }

  return result
}

// ═══ Polygon Clipping V2: per-axis range clip (geojson-vt port) ═══

/**
 * Clip polygon rings to an axis-aligned rectangle. Same signature as
 * {@link clipPolygonToRect}, different internal algorithm.
 *
 * Algorithm (mapbox/geojson-vt clip.js, MIT, ported without changes
 * to behaviour — only adapted from flat-array geometry to the
 * `number[][]` ring shape this codebase uses): two passes total, one
 * per axis. Each pass walks the ring edges and slices each edge
 * against the [k1, k2] range on that axis simultaneously:
 *
 *   - both endpoints below k1  → edge contributes nothing
 *   - both endpoints above k2  → edge contributes nothing
 *   - both endpoints inside    → edge contributes the next vertex
 *   - one inside / one outside → emit one boundary intersection
 *   - both outside on opposite sides → emit BOTH boundary
 *     intersections (the case Sutherland-Hodgman handles only via
 *     two sequential half-plane passes that can produce subtly
 *     different vertex orderings)
 *
 * Closes the output ring (last vertex == first) when the input
 * crossed the range boundary.
 */
export function clipPolygonToRectV2(
  rings: number[][][],
  west: number,
  south: number,
  east: number,
  north: number,
  precision?: number,
): number[][][] {
  const result: number[][][] = []

  for (const ring of rings) {
    // First clip against the X axis range [west, east]
    let clipped = clipRingAxisRange(ring, west, east, 0, precision)
    if (clipped.length < 3) continue
    // Then clip the result against the Y axis range [south, north]
    clipped = clipRingAxisRange(clipped, south, north, 1, precision)
    if (clipped.length < 3) continue
    result.push(clipped)
  }

  return result
}

/** Clip a single ring against `[k1, k2]` on `axis` in one pass.
 *  Handles the "edge straddles both bounds" case in one step instead
 *  of two sequential half-plane clips. */
function clipRingAxisRange(
  ring: number[][],
  k1: number,
  k2: number,
  axis: 0 | 1,
  precision?: number,
): number[][] {
  if (ring.length === 0) return []

  const out: number[][] = []
  const len = ring.length

  // Treat the ring as a closed loop — iterate `len` edges, the last
  // edge wraps from ring[len-1] back to ring[0]. Inputs may or may
  // not repeat the first vertex at the end; either way the wrap
  // covers the closing edge.
  for (let i = 0; i < len; i++) {
    const curr = ring[i]
    const next = ring[(i + 1) % len]
    const a = curr[axis]
    const b = next[axis]

    if (a < k1) {
      // Start below k1
      if (b > k2) {
        // Edge spans below k1 → above k2 → emit both intersections
        out.push(intersect(curr, next, k1, axis, precision))
        out.push(intersect(curr, next, k2, axis, precision))
      } else if (b >= k1) {
        // Edge enters from below k1 and stops inside the range
        out.push(intersect(curr, next, k1, axis, precision))
        out.push(next)
      }
      // else: both below k1 — nothing
    } else if (a > k2) {
      // Start above k2
      if (b < k1) {
        // Edge spans above k2 → below k1 → emit both intersections
        out.push(intersect(curr, next, k2, axis, precision))
        out.push(intersect(curr, next, k1, axis, precision))
      } else if (b <= k2) {
        // Edge enters from above k2 and stops inside the range
        out.push(intersect(curr, next, k2, axis, precision))
        out.push(next)
      }
      // else: both above k2 — nothing
    } else {
      // Start inside [k1, k2]
      if (b < k1) {
        // Exits below k1 — emit boundary intersection (next vertex
        // is outside, so we don't push it)
        out.push(intersect(curr, next, k1, axis, precision))
      } else if (b > k2) {
        // Exits above k2
        out.push(intersect(curr, next, k2, axis, precision))
      } else {
        // Edge stays inside the range — emit next vertex
        out.push(next)
      }
    }
  }

  return out
}

/**
 * Clip a ring against a single edge (half-plane).
 * @param ring Array of [lon, lat] points
 * @param value The edge coordinate value
 * @param axis 0 = longitude (x), 1 = latitude (y)
 * @param keepAbove true = keep points where coord[axis] >= value
 */
function clipRingToEdge(
  ring: number[][],
  value: number,
  axis: 0 | 1,
  keepAbove: boolean,
  precision?: number,
): number[][] {
  if (ring.length === 0) return []

  const out: number[][] = []
  const len = ring.length

  for (let i = 0; i < len; i++) {
    const curr = ring[i]
    const next = ring[(i + 1) % len]

    const currInside = keepAbove ? curr[axis] >= value : curr[axis] <= value
    const nextInside = keepAbove ? next[axis] >= value : next[axis] <= value

    if (currInside) {
      if (nextInside) {
        out.push(next)
      } else {
        out.push(intersect(curr, next, value, axis, precision))
      }
    } else {
      if (nextInside) {
        out.push(intersect(curr, next, value, axis, precision))
        out.push(next)
      }
    }
  }

  return out
}

/** Snap a value to a quantization grid (deterministic across tiles) */
function snapToGrid(v: number, precision: number): number {
  return Math.round(v * precision) / precision
}

/** Compute intersection of segment a→b with edge at value on given axis.
 *  The boundary-axis coordinate is exact (= value).
 *  The perpendicular coordinate is snapped to precision grid to ensure
 *  adjacent tiles produce identical boundary vertices. */
function intersect(a: number[], b: number[], value: number, axis: 0 | 1, precision?: number): number[] {
  const t = (value - a[axis]) / (b[axis] - a[axis])
  const other = a[1 - axis] + t * (b[1 - axis] - a[1 - axis])
  return axis === 0
    ? [value, precision ? snapToGrid(other, precision) : other]
    : [precision ? snapToGrid(other, precision) : other, value]
}

// ═══ Line Clipping ═══

/**
 * Clip a linestring to an axis-aligned rectangle.
 * A single line may be split into multiple segments.
 * @returns Array of line segments (each is [[lon,lat], ...])
 */
export function clipLineToRect(
  coords: number[][],
  west: number,
  south: number,
  east: number,
  north: number,
  precision?: number,
): number[][][] {
  if (coords.length < 2) return []

  const segments: number[][][] = []
  let current: number[][] = []

  for (let i = 0; i < coords.length - 1; i++) {
    const clipped = clipSegment(coords[i], coords[i + 1], west, south, east, north, precision)
    if (clipped) {
      if (current.length === 0) {
        current.push(clipped[0], clipped[1])
      } else {
        // Check if this segment continues from the previous
        const last = current[current.length - 1]
        if (Math.abs(last[0] - clipped[0][0]) < 1e-10 && Math.abs(last[1] - clipped[0][1]) < 1e-10) {
          current.push(clipped[1])
        } else {
          // Discontinuity — start new segment
          if (current.length >= 2) segments.push(current)
          current = [clipped[0], clipped[1]]
        }
      }
    } else {
      // Segment fully outside — break current run
      if (current.length >= 2) segments.push(current)
      current = []
    }
  }

  if (current.length >= 2) segments.push(current)
  return segments
}

/**
 * Clip a single line segment to a rectangle.
 * Returns [clippedStart, clippedEnd] or null if entirely outside.
 * Uses parametric clipping (Liang-Barsky style).
 */
function clipSegment(
  a: number[],
  b: number[],
  west: number,
  south: number,
  east: number,
  north: number,
  precision?: number,
): [number[], number[]] | null {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]

  let tMin = 0
  let tMax = 1

  if (!clipEdge(-dx, a[0] - west)) return null
  if (!clipEdge(dx, east - a[0])) return null
  if (!clipEdge(-dy, a[1] - south)) return null
  if (!clipEdge(dy, north - a[1])) return null

  function clipEdge(p: number, q: number): boolean {
    if (Math.abs(p) < 1e-15) return q >= 0
    const r = q / p
    if (p < 0) {
      if (r > tMax) return false
      if (r > tMin) tMin = r
    } else {
      if (r < tMin) return false
      if (r < tMax) tMax = r
    }
    return true
  }

  // Reject degenerate clips where the segment merely touches the tile
  // boundary without crossing it (tMin ≈ tMax). A common case: a polyline
  // vertex sits exactly on a tile edge, producing a [B, B] zero-length
  // result that creates a ghost segment in the output (visible as a small
  // square artifact and corrupted join tangent in the adjacent segment).
  if (tMax - tMin < 1e-10) return null

  const p0: number[] = [a[0] + tMin * dx, a[1] + tMin * dy]
  const p1: number[] = [a[0] + tMax * dx, a[1] + tMax * dy]

  // Interpolate any extra per-vertex data (e.g., arc_start at index 2)
  if (a.length > 2 && b.length > 2) {
    for (let k = 2; k < Math.min(a.length, b.length); k++) {
      p0.push(a[k] + tMin * (b[k] - a[k]))
      p1.push(a[k] + tMax * (b[k] - a[k]))
    }
  }

  // Override tangent fields — direction unit vectors must NOT be linearly
  // interpolated along the segment. When augmentLineWithArc stores
  // [lon, lat, arc, tin_x, tin_y, tout_x, tout_y], indices 3-6 carry the
  // join tangent at each original vertex.
  //
  // For ORIGINAL vertices (tMin≈0 / tMax≈1) we preserve the join tangent so
  // the renderer knows the true turn angle even across tile boundaries.
  //
  // For MID-SEGMENT clip points (tMin>0 / tMax<1) we zero the tangent so
  // the runtime falls back to its boundary-detection heuristic (segment
  // direction = straight continuation). Propagating the original vertex's
  // tangent here would create a FAKE join at the clip point with the wrong
  // angle, causing asymmetric quad expansion and visible line misalignment
  // between adjacent tiles.
  if (a.length >= 7 && b.length >= 7) {
    if (tMin < 1e-10) {
      p0[3] = a[3]; p0[4] = a[4]; p0[5] = a[5]; p0[6] = a[6]
    } else {
      p0[3] = 0; p0[4] = 0; p0[5] = 0; p0[6] = 0
    }
    if (tMax > 1 - 1e-10) {
      p1[3] = b[3]; p1[4] = b[4]; p1[5] = b[5]; p1[6] = b[6]
    } else {
      p1[3] = 0; p1[4] = 0; p1[5] = 0; p1[6] = 0
    }
  }

  // Snap boundary-clipped endpoints to precision grid for tile consistency
  if (precision) {
    const EPS = 1e-10
    for (const pt of [p0, p1]) {
      const onBoundaryX = Math.abs(pt[0] - west) < EPS || Math.abs(pt[0] - east) < EPS
      const onBoundaryY = Math.abs(pt[1] - south) < EPS || Math.abs(pt[1] - north) < EPS
      if (onBoundaryX) pt[1] = snapToGrid(pt[1], precision)
      if (onBoundaryY) pt[0] = snapToGrid(pt[0], precision)
    }
  }

  return [p0, p1]
}
