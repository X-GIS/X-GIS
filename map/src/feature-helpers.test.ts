import { describe, it, expect } from 'vitest'
import { featureAnchor } from './feature-helpers'

// Ray-casting point-in-polygon (even-odd) — the oracle the #727 fix must
// satisfy: the returned anchor must lie INSIDE the ring, where the old bbox
// centre did not.
function inside(ring: [number, number][], p: [number, number]): boolean {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]
    const yi = ring[i]![1]
    const xj = ring[j]![0]
    const yj = ring[j]![1]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

// Whether a point lies (within eps) on any segment of a polyline.
function onLine(coords: [number, number][], p: [number, number], eps = 1e-6): boolean {
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!
    const b = coords[i]!
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len2 = dx * dx + dy * dy
    if (len2 === 0) continue
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
    if (t < -eps || t > 1 + eps) continue
    const cx = a[0] + t * dx
    const cy = a[1] + t * dy
    if (Math.hypot(p[0] - cx, p[1] - cy) < 1e-4) return true
  }
  return false
}

describe('#727 featureAnchor — interior anchor (polygon / line)', () => {
  // A "C" opening to the right: the bbox centre (5,5) falls in the notch,
  // i.e. OUTSIDE the polygon — the exact bug.
  const cShape: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 4],
    [4, 4],
    [4, 6],
    [10, 6],
    [10, 10],
    [0, 10],
    [0, 0],
  ]

  it('concave polygon: bbox centre is OUTSIDE, the new anchor is INSIDE', () => {
    // Pin the premise: the OLD strategy (bbox centre) really is outside.
    expect(inside(cShape, [5, 5]), 'bbox centre falls in the notch (old bug)').toBe(false)
    const a = featureAnchor({ type: 'Polygon', coordinates: [cShape] })
    expect(a).not.toBeNull()
    expect(inside(cShape, a as [number, number]), 'new anchor is inside the C').toBe(true)
  })

  it('MultiPolygon: anchors the LARGEST-area part, not the first', () => {
    const small: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ]
    const big: [number, number][] = [
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
      [10, 10],
    ]
    // small part FIRST — the old `coordinates[0][0]` would label it.
    const a = featureAnchor({ type: 'MultiPolygon', coordinates: [[small], [big]] })
    expect(a).not.toBeNull()
    expect(inside(big, a as [number, number]), 'anchor is in the big part').toBe(true)
    expect(inside(small, a as [number, number]), 'anchor is NOT in the small first part').toBe(
      false,
    )
  })

  it('LineString: anchor lies ON the line (not the bbox centre off it)', () => {
    // L-shape: bbox centre (5,5) is off the line; the 50% arc-length point is on it.
    const line: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ]
    expect(onLine(line, [5, 5]), 'bbox centre is off the L (old bug)').toBe(false)
    const a = featureAnchor({ type: 'LineString', coordinates: line })
    expect(a).not.toBeNull()
    expect(onLine(line, a as [number, number]), 'anchor is on the line').toBe(true)
    // Total length 20 → 50% at length 10 → exactly the corner vertex.
    expect(a![0]).toBeCloseTo(10, 6)
    expect(a![1]).toBeCloseTo(0, 6)
  })

  it('MultiLineString: anchors the LONGEST chain', () => {
    const shortFirst: [number, number][] = [
      [0, 0],
      [1, 0],
    ]
    const longSecond: [number, number][] = [
      [100, 100],
      [140, 100],
    ]
    const a = featureAnchor({ type: 'MultiLineString', coordinates: [shortFirst, longSecond] })
    expect(a).not.toBeNull()
    expect(onLine(longSecond, a as [number, number]), 'anchor is on the long chain').toBe(true)
  })

  it('Point / MultiPoint unchanged; degenerate shapes return null', () => {
    expect(featureAnchor({ type: 'Point', coordinates: [3, 4] })).toEqual([3, 4])
    expect(featureAnchor({ type: 'MultiPoint', coordinates: [[7, 8]] })).toEqual([7, 8])
    expect(featureAnchor({ type: 'Polygon', coordinates: [[]] })).toBeNull()
    expect(featureAnchor({ type: 'LineString', coordinates: [] })).toBeNull()
    // A malformed ring (all non-numeric points) must not throw — returns null.
    expect(
      featureAnchor({ type: 'Polygon', coordinates: [[[NaN, NaN] as never]] as never }),
    ).toBeNull()
  })

  it('convex polygon still yields an interior anchor (no regression)', () => {
    const square: [number, number][] = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [0, 0],
    ]
    const a = featureAnchor({ type: 'Polygon', coordinates: [square] })
    expect(inside(square, a as [number, number])).toBe(true)
  })
})
