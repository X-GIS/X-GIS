import { describe, it, expect } from 'vitest'
import { featureAnchor } from './feature-helpers'

// Independent even-odd point-in-polygon over outer + holes — deliberately a
// SECOND implementation (not the one under test) so the invariant "the anchor
// lies inside the filled area" is checked against fresh code, not the same
// crossing logic featureAnchor uses internally.
function inside(x: number, y: number, rings: number[][][]): boolean {
  let hit = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!
      const [xj, yj] = ring[j]!
      if (yi! > y !== yj! > y && x < ((xj! - xi!) * (y - yi!)) / (yj! - yi!) + xi!) hit = !hit
    }
  }
  return hit
}

describe('featureAnchor — points and lines (unchanged)', () => {
  it('Point returns its coordinate', () => {
    expect(featureAnchor({ type: 'Point', coordinates: [12, 34] })).toEqual([12, 34])
  })
  it('MultiPoint returns the first coordinate', () => {
    expect(
      featureAnchor({
        type: 'MultiPoint',
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      }),
    ).toEqual([1, 2])
  })
})

describe('featureAnchor — polygon interior point (#727 P3)', () => {
  it('convex polygon: keeps the bbox centre (byte-identical to the old anchor)', () => {
    const square = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ]
    // bbox centre of the outer ring is (5, 5); it is inside a convex square,
    // so the anchor must be exactly that — no behavioural change.
    expect(featureAnchor({ type: 'Polygon', coordinates: square })).toEqual([5, 5])
  })

  it('concave U-polygon: old bbox centre is OUTSIDE, new anchor is INSIDE', () => {
    // A "U" opening upward: solid below y=3 across x∈[0,10]; above y=3 only the
    // two arms x∈[0,3] and x∈[7,10]. The bbox centre (5,5) lands in the notch.
    const u = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [7, 10],
        [7, 3],
        [3, 3],
        [3, 10],
        [0, 10],
        [0, 0],
      ],
    ]
    expect(inside(5, 5, u)).toBe(false) // the historical bbox-centre anchor fell outside
    const a = featureAnchor({ type: 'Polygon', coordinates: u })!
    expect(a).not.toBeNull()
    expect(inside(a[0], a[1], u)).toBe(true) // the new anchor is provably inside
  })

  it('polygon with a hole: centre-in-hole is rejected, anchor sits in the solid', () => {
    const withHole = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [3, 3],
        [7, 3],
        [7, 7],
        [3, 7],
        [3, 3],
      ],
    ]
    expect(inside(5, 5, withHole)).toBe(false) // (5,5) is inside the hole → not solid
    const a = featureAnchor({ type: 'Polygon', coordinates: withHole })!
    expect(inside(a[0], a[1], withHole)).toBe(true)
  })
})

describe('featureAnchor — MultiPolygon largest part (#727 P3)', () => {
  it('anchors on the largest-area part, not the first-listed', () => {
    // First part is a tiny 2×2 square (area 4); second is a 10×10 square
    // (area 100). The old code took the first part; the new code must take
    // the larger one.
    const mp = [
      [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
      [
        [
          [10, 10],
          [20, 10],
          [20, 20],
          [10, 20],
          [10, 10],
        ],
      ],
    ]
    const small = mp[0]!
    const large = mp[1]!
    const a = featureAnchor({ type: 'MultiPolygon', coordinates: mp })!
    expect(a).not.toBeNull()
    expect(inside(a[0], a[1], large)).toBe(true)
    expect(inside(a[0], a[1], small)).toBe(false)
  })
})

describe('featureAnchor — line 50%-arc-length anchor (#727 line half)', () => {
  // A point lies (within eps) on any segment of a polyline.
  const onLine = (coords: [number, number][], p: [number, number]): boolean => {
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1]!
      const b = coords[i]!
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const len2 = dx * dx + dy * dy
      if (len2 === 0) continue
      const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
      if (t < -1e-6 || t > 1 + 1e-6) continue
      if (Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)) < 1e-4) return true
    }
    return false
  }

  it('LineString anchor lies ON the line, not the bbox centre off it', () => {
    // L-shape: bbox centre (5,5) floats off the line; the 50% arc-length point is on it.
    const line: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ]
    expect(onLine(line, [5, 5]), 'bbox centre is off the L (the old anchor)').toBe(false)
    const a = featureAnchor({ type: 'LineString', coordinates: line })!
    expect(a).not.toBeNull()
    expect(onLine(line, a as [number, number]), 'new anchor is on the line').toBe(true)
    // Total length 20 → 50% at length 10 → exactly the corner vertex.
    expect(a[0]).toBeCloseTo(10, 6)
    expect(a[1]).toBeCloseTo(0, 6)
  })

  it('MultiLineString anchors the LONGEST chain', () => {
    const shortFirst: [number, number][] = [
      [0, 0],
      [1, 0],
    ]
    const longSecond: [number, number][] = [
      [100, 100],
      [140, 100],
    ]
    const a = featureAnchor({ type: 'MultiLineString', coordinates: [shortFirst, longSecond] })!
    expect(a).not.toBeNull()
    expect(onLine(longSecond, a as [number, number]), 'anchor on the long chain').toBe(true)
  })

  it('degenerate lines: empty → null, single vertex → itself', () => {
    expect(featureAnchor({ type: 'LineString', coordinates: [] })).toBeNull()
    expect(featureAnchor({ type: 'LineString', coordinates: [[3, 4]] })).toEqual([3, 4])
  })
})
