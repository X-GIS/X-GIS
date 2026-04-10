// ═══ Geometry Clipping ═══
// Sutherland-Hodgman polygon clipping + line segment clipping
// against axis-aligned rectangles (tile boundaries).
// Zero dependencies — pure math.

// ═══ Polygon Clipping: Sutherland-Hodgman ═══

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
): number[][][] {
  const result: number[][][] = []

  for (const ring of rings) {
    let clipped = ring
    clipped = clipRingToEdge(clipped, west, 0, true)   // keep lon >= west
    if (clipped.length < 3) continue
    clipped = clipRingToEdge(clipped, east, 0, false)  // keep lon <= east
    if (clipped.length < 3) continue
    clipped = clipRingToEdge(clipped, south, 1, true)  // keep lat >= south
    if (clipped.length < 3) continue
    clipped = clipRingToEdge(clipped, north, 1, false) // keep lat <= north
    if (clipped.length < 3) continue
    result.push(clipped)
  }

  return result
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
        // Both inside → emit next
        out.push(next)
      } else {
        // Curr inside, next outside → emit intersection
        out.push(intersect(curr, next, value, axis))
      }
    } else {
      if (nextInside) {
        // Curr outside, next inside → emit intersection + next
        out.push(intersect(curr, next, value, axis))
        out.push(next)
      }
      // Both outside → emit nothing
    }
  }

  return out
}

/** Compute intersection of segment a→b with edge at value on given axis */
function intersect(a: number[], b: number[], value: number, axis: 0 | 1): number[] {
  const t = (value - a[axis]) / (b[axis] - a[axis])
  return [
    a[0] + t * (b[0] - a[0]),
    a[1] + t * (b[1] - a[1]),
  ]
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
): number[][][] {
  if (coords.length < 2) return []

  const segments: number[][][] = []
  let current: number[][] = []

  for (let i = 0; i < coords.length - 1; i++) {
    const clipped = clipSegment(coords[i], coords[i + 1], west, south, east, north)
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
): [number[], number[]] | null {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]

  let tMin = 0
  let tMax = 1

  // Clip against each edge
  // Left (west): -dx * t <= a[0] - west
  if (!clipEdge(-dx, a[0] - west)) return null
  // Right (east): dx * t <= east - a[0]
  if (!clipEdge(dx, east - a[0])) return null
  // Bottom (south): -dy * t <= a[1] - south
  if (!clipEdge(-dy, a[1] - south)) return null
  // Top (north): dy * t <= north - a[1]
  if (!clipEdge(dy, north - a[1])) return null

  function clipEdge(p: number, q: number): boolean {
    if (Math.abs(p) < 1e-15) {
      // Parallel to edge
      return q >= 0
    }
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

  if (tMin > tMax) return null

  return [
    [a[0] + tMin * dx, a[1] + tMin * dy],
    [a[0] + tMax * dx, a[1] + tMax * dy],
  ]
}
