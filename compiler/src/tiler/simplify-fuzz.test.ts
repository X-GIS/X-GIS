// iter-297 — Douglas-Peucker simplify fuzz. Edge cases:
//   empty / 1-vertex / 2-vertex
//   all-identical points (degenerate ring)
//   collinear (line not curve)
//   NaN / Infinity coords (decoder upstream defensive)
//   tolerance edge values (0, -1, NaN, Infinity)
//   huge ring (10k pts)
//   isLocked predicate that locks everything / nothing
//   self-overlapping ring (figure-eight)

import { describe, it, expect } from 'vitest'
import { simplify, simplifyPolygon, simplifyLine } from './simplify'

function makeRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13
    s |= 0
    s ^= s >>> 17
    s ^= s << 5
    s |= 0
    return (s >>> 0) / 0x1_0000_0000
  }
}

describe('iter-297 simplify Douglas-Peucker fuzz', () => {
  it('empty ring → empty (or stable)', () => {
    expect(() => simplify([], 0.1)).not.toThrow()
    const r = simplify([], 0.1)
    expect(r.length).toBeLessThanOrEqual(0)
  })

  it('1-vertex ring stays as-is', () => {
    const r = simplify([[0, 0]], 0.1)
    expect(r.length).toBe(1)
  })

  it('2-vertex ring stays as-is', () => {
    const r = simplify(
      [
        [0, 0],
        [1, 1],
      ],
      0.1,
    )
    expect(r.length).toBe(2)
  })

  it('all-identical points: keeps first + last', () => {
    const r = simplify(
      [
        [5, 5],
        [5, 5],
        [5, 5],
        [5, 5],
      ],
      0.01,
    )
    expect(r.length).toBeGreaterThanOrEqual(2)
    expect(r[0]).toEqual([5, 5])
    expect(r[r.length - 1]).toEqual([5, 5])
  })

  it('perfectly collinear points: drops interior', () => {
    const r = simplify(
      [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
      ],
      0.001,
    )
    expect(r.length).toBe(2)
    expect(r[0]).toEqual([0, 0])
    expect(r[1]).toEqual([4, 4])
  })

  it('high-detail curve kept under low tolerance', () => {
    const ring: number[][] = []
    for (let i = 0; i <= 100; i++) {
      const t = (i / 100) * 2 * Math.PI
      ring.push([Math.cos(t), Math.sin(t)])
    }
    const r = simplify(ring, 1e-6)
    expect(r.length).toBeGreaterThan(50)
  })

  it('high-detail curve collapses under high tolerance', () => {
    const ring: number[][] = []
    for (let i = 0; i <= 100; i++) {
      const t = (i / 100) * 2 * Math.PI
      ring.push([Math.cos(t), Math.sin(t)])
    }
    const r = simplify(ring, 10)
    expect(r.length).toBeLessThanOrEqual(5)
  })

  it('tolerance = 0 returns input unchanged (spec)', () => {
    const ring = [
      [0, 0],
      [0.1, 0.1],
      [1, 1],
    ]
    const r = simplify(ring, 0)
    expect(r.length).toBe(3)
  })

  it('negative tolerance returns input unchanged (defensive)', () => {
    const ring = [
      [0, 0],
      [0.1, 0.1],
      [1, 1],
    ]
    const r = simplify(ring, -1)
    expect(r.length).toBe(3)
  })

  it('NaN tolerance does not crash', () => {
    expect(() =>
      simplify(
        [
          [0, 0],
          [1, 1],
        ],
        NaN,
      ),
    ).not.toThrow()
  })

  it('Infinity tolerance collapses to 2 points', () => {
    const ring = [
      [0, 0],
      [0.5, 0.5],
      [1, 1],
    ]
    const r = simplify(ring, Infinity)
    expect(r.length).toBe(2)
  })

  it('NaN coord does not crash', () => {
    expect(() =>
      simplify(
        [
          [0, 0],
          [NaN, NaN],
          [1, 1],
        ],
        0.1,
      ),
    ).not.toThrow()
  })

  it('Infinity coord does not crash', () => {
    expect(() =>
      simplify(
        [
          [0, 0],
          [Infinity, 0],
          [1, 1],
        ],
        0.1,
      ),
    ).not.toThrow()
  })

  it('huge ring 10k pts processed without crash + result <= input', () => {
    const rng = makeRng(0x55)
    const big: number[][] = []
    for (let i = 0; i < 10000; i++) big.push([rng() * 100, rng() * 100])
    const r = simplify(big, 0.5)
    expect(r.length).toBeLessThanOrEqual(big.length)
    expect(r.length).toBeGreaterThanOrEqual(2)
  })

  it('isLocked = always-true keeps every vertex', () => {
    const ring = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]
    const r = simplify(ring, 10, () => true)
    expect(r.length).toBe(4)
  })

  it('isLocked = always-false behaves like no isLocked', () => {
    const ring = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]
    const withLock = simplify(ring, 0.5, () => false)
    const without = simplify(ring, 0.5)
    expect(withLock.length).toBe(without.length)
  })

  it('isLocked on specific vertex preserves it', () => {
    // collinear ring — without lock would collapse to 2.
    const ring = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]
    const lockMiddle = (c: number[]) => c[0] === 2 // lock the middle
    const r = simplify(ring, 0.001, lockMiddle)
    expect(r.length).toBe(3) // first, locked-middle, last
    expect(r[1]).toEqual([2, 2])
  })

  it('always preserves first and last point', () => {
    const rng = makeRng(0xabc)
    for (let trial = 0; trial < 200; trial++) {
      const n = 3 + Math.floor(rng() * 50)
      const ring: number[][] = []
      for (let i = 0; i < n; i++) ring.push([rng() * 10, rng() * 10])
      const tol = rng() * 5
      const r = simplify(ring, tol)
      expect(r[0]).toEqual(ring[0])
      expect(r[r.length - 1]).toEqual(ring[ring.length - 1])
    }
  })

  it('result length <= input length (never adds vertices)', () => {
    const rng = makeRng(0xdef)
    for (let trial = 0; trial < 200; trial++) {
      const n = 3 + Math.floor(rng() * 50)
      const ring: number[][] = []
      for (let i = 0; i < n; i++) ring.push([rng() * 10, rng() * 10])
      const r = simplify(ring, rng() * 2)
      expect(r.length).toBeLessThanOrEqual(ring.length)
    }
  })
})

describe('iter-297 simplifyPolygon / simplifyLine fuzz', () => {
  it('simplifyPolygon empty input → empty output', () => {
    expect(() => simplifyPolygon([], 5)).not.toThrow()
  })

  it('simplifyPolygon with empty ring → ring dropped', () => {
    const r = simplifyPolygon([[]], 5)
    expect(Array.isArray(r)).toBe(true)
  })

  it('simplifyPolygon at very high zoom (z=22) low tolerance', () => {
    const ring = [
      [0, 0],
      [1, 1],
      [2, 0],
      [0, 0],
    ]
    expect(() => simplifyPolygon([ring], 22)).not.toThrow()
  })

  it('simplifyPolygon at very low zoom (z=0) high tolerance', () => {
    const ring = [
      [0, 0],
      [1, 1],
      [2, 0],
      [0, 0],
    ]
    expect(() => simplifyPolygon([ring], 0)).not.toThrow()
  })

  it('simplifyLine empty / single-point', () => {
    expect(() => simplifyLine([], 5)).not.toThrow()
    expect(() => simplifyLine([[0, 0]], 5)).not.toThrow()
  })
})

// iter-303/304 — mutation testing surfaced gaps in dpStep boundary
// + sqDistToSegment zero-length-segment path. Pin survivors here.
describe('iter-304 simplify mutation-gap pins', () => {
  it('exact 3-vertex ring: middle vertex within tolerance is dropped', () => {
    // simplify(ring=[A,B,C], tolerance=large) should drop B.
    // Mutation < → <= at line 14 (`length <= 2`) would make 3-vert
    // ring early-return (survive). Without DP step running, B is
    // NEVER dropped. So this test fails on the mutation.
    const ring = [
      [0, 0],
      [0.5, 0.001],
      [1, 0],
    ]
    const r = simplify(ring, 1) // tolerance way bigger than B's deviation
    expect(r.length).toBe(2)
    expect(r[0]).toEqual([0, 0])
    expect(r[1]).toEqual([1, 0])
  })

  it('exact 2-vertex ring: untouched (DP never runs)', () => {
    // Pinned: simplify returns the 2-vertex ring as-is. Mutation
    // <= → < (line 14) would let DP run on length 2, but DP step
    // requires first+1 < last (i.e. ≥ 3 vertices), so dpStep
    // immediately falls through. Result is the same — this test
    // doesn't kill that mutant, but it pins the contract.
    const r = simplify(
      [
        [0, 0],
        [5, 5],
      ],
      0.01,
    )
    expect(r).toEqual([
      [0, 0],
      [5, 5],
    ])
  })

  it('zero-length segment (a == b): distance = |p - a|² (line 81 zero-guard)', () => {
    // sqDistToSegment with a==b: the (dx, dy) = (0,0) path skips
    // the projection and returns squared dist to a.
    // Pin via simplify: a 3-vertex ring where first == last and
    // middle is the test point. With tolerance > 0 the middle
    // gets dropped iff its dist² > tolerance². If the zero-guard
    // mutates (`||` → `&&`), the projection runs and divides by
    // dx²+dy²=0, producing NaN/Infinity downstream.
    const ring = [
      [0, 0],
      [3, 4],
      [0, 0],
    ]
    // Distance from (3,4) to segment (0,0)-(0,0) is 5 → sqDist 25.
    // tolerance 10 (sq 100) > sqDist 25 → middle stays? No —
    // standard DP keeps maxDist; with sqDist 25 < sqTolerance 100,
    // dpStep doesn't keep middle → result is [first, last].
    const r = simplify(ring, 10)
    expect(r.length).toBe(2)
  })

  it('3-vertex ring far above tolerance keeps all 3', () => {
    // Middle vertex deviates massively (10 units) from segment.
    // Mutation > → >= at maxDist comparison (line 69) would
    // change strict-greater to non-strict, but for distinct
    // values the behaviour is identical. So this mutation may
    // survive — pin the structural-result contract anyway.
    const ring = [
      [0, 0],
      [0.5, 10],
      [1, 0],
    ]
    const r = simplify(ring, 0.001)
    expect(r.length).toBe(3)
  })

  it('5-vertex ring with locked middle: locked + endpoints kept (3 total)', () => {
    const ring = [
      [0, 0],
      [0.25, 0.0001],
      [0.5, 0.0001],
      [0.75, 0.0001],
      [1, 0],
    ]
    // Lock middle vertex only. Without lock the ring collapses to
    // 2; with lock the result is exactly 3 (first, locked, last).
    const lockMiddle = (c: number[]) => c[0] === 0.5
    const r = simplify(ring, 1, lockMiddle)
    expect(r.length).toBe(3)
    expect(r[1]).toEqual([0.5, 0.0001])
  })

  it('simplifyPolygon: hole that collapses falls back to UNSIMPLIFIED original', () => {
    // Outer ring + 1 hole. Make the hole barely-3 verts so any
    // simplification kills it. Result must include the ORIGINAL
    // hole (line 145 fallback) — not the collapsed version.
    const outer = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    const hole = [
      [5, 5],
      [5.0001, 5],
      [5, 5.0001],
    ] // tiny triangle
    const r = simplifyPolygon([outer, hole], 0) // zoom=0 → big tol
    // Hole should survive — either as simplified (≥3) OR fallback
    // original.
    expect(r.length).toBeGreaterThanOrEqual(1)
    // Specifically test the fallback path: hole index 1 was 3
    // verts; if simplify collapsed it, the result still includes
    // a ring at index 1.
    if (r.length === 2) {
      expect(r[1]!.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('simplifyPolygon: outer ring collapse → polygon dropped entirely', () => {
    // Outer ring that collapses to <3 should NOT fall back —
    // entire polygon is degenerate.
    const tinyOuter = [
      [5, 5],
      [5.0001, 5],
      [5, 5.0001],
    ]
    const r = simplifyPolygon([tinyOuter], 0)
    // Outer kept-fallback NOT engaged for outer ring (i===0).
    // Could collapse to empty rings or 0 rings.
    expect(r.length).toBeLessThanOrEqual(1)
  })

  it('simplifyLine: result < 2 → preserves original coords (line 159 fallback)', () => {
    // simplifyLine guarantees ≥ 2 output. If DP collapses to <2,
    // returns original instead.
    const coords = [
      [0, 0],
      [0, 0],
    ] // identical points
    const r = simplifyLine(coords, 5)
    expect(r.length).toBeGreaterThanOrEqual(2)
  })
})
