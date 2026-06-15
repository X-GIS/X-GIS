import { describe, it, expect } from 'vitest'
import { simplify, simplifyPolygon } from './simplify'

// Regression: Douglas-Peucker `dpStep` was recursive and overflowed the JS
// native call stack on large rings — `RangeError: Maximum call stack size
// exceeded` thrown in the tiler worker for EVERY tile on the `categorical`
// demo (countries.geojson) at low zoom. dpStep is now an explicit-stack
// iterative loop; these rings drive the recursion depth past the native
// ceiling, so they throw pre-fix and pass post-fix.

// Worst-case DP depth is O(n): a long run where each split peels a single
// vertex. A run of locked (boundary) vertices forces exactly that — the
// locked branch recurses one vertex at a time. This is the categorical-demo
// mechanism: at z0 a country ring clamped along the antimeridian / ±85°
// Mercator boundary carries a long run of boundary-LOCKED vertices, so the
// recursion descends one vertex per level and overflows the native stack.
// This is the fail-before case (throws RangeError on the recursive form).
function lockedRun(n: number): number[][] {
  const ring: number[][] = []
  for (let i = 0; i < n; i++) ring.push([i, (i % 2) * 0.5])
  return ring
}

// A deterministic high-vertex jagged ring (pseudo-random walk) — large-ring
// smoke: realistic geometry splits near-balanced (~O(log n)) so it does NOT
// overflow, but it guards that the iterative form handles 100k+ vertices
// without error or runaway cost.
function jaggedRing(n: number): number[][] {
  const ring: number[][] = []
  let s = 12345
  let x = 0, y = 0
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    x += 1
    y += ((s % 1000) - 500) / 100 // ±5 jitter
    ring.push([x, y])
  }
  return ring
}

describe('dpStep stack-overflow regression (iterative Douglas-Peucker)', () => {
  it('simplifies a long locked-vertex run without RangeError', () => {
    const ring = lockedRun(60_000)
    const lockAll = () => true
    let out: number[][] = []
    expect(() => { out = simplify(ring, 1, lockAll) }).not.toThrow()
    // All vertices locked → all kept.
    expect(out.length).toBe(ring.length)
  })

  it('simplifies a huge jagged ring without RangeError', () => {
    const ring = jaggedRing(120_000)
    let out: number[][] = []
    expect(() => { out = simplify(ring, 2) }).not.toThrow()
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out.length).toBeLessThanOrEqual(ring.length)
    // endpoints always preserved
    expect(out[0]).toEqual(ring[0])
    expect(out[out.length - 1]).toEqual(ring[ring.length - 1])
  })

  it('simplifyPolygon handles a huge ring without RangeError', () => {
    const ring = jaggedRing(120_000)
    // close the ring
    ring.push(ring[0]!)
    expect(() => simplifyPolygon([ring], 5, undefined, 2)).not.toThrow()
  })
})

describe('iterative dpStep preserves Douglas-Peucker semantics', () => {
  it('drops a near-collinear midpoint, keeps a deviating one', () => {
    // midpoint deviates by 5 (>tol) → kept; with tiny deviation → dropped.
    expect(simplify([[0, 0], [5, 5], [10, 0]], 1)).toEqual([[0, 0], [5, 5], [10, 0]])
    expect(simplify([[0, 0], [5, 0.001], [10, 0]], 1)).toEqual([[0, 0], [10, 0]])
  })

  it('honours locked vertices even below tolerance', () => {
    // middle vertex is collinear (would drop) but locked → survives.
    const ring = [[0, 0], [5, 0], [10, 0]]
    const lockMid = (c: number[]) => c[0] === 5
    expect(simplify(ring, 1, lockMid)).toEqual([[0, 0], [5, 0], [10, 0]])
  })

  it('matches a known multi-point DP result', () => {
    // classic small case: only the two far-deviating peaks survive at tol 1.
    const ring = [[0, 0], [1, 0.1], [2, 4], [3, 0.1], [4, 0], [5, 4], [6, 0]]
    const out = simplify(ring, 1)
    expect(out).toEqual([[0, 0], [2, 4], [4, 0], [5, 4], [6, 0]])
  })
})
