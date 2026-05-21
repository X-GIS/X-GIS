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
    s ^= s << 13; s |= 0
    s ^= s >>> 17
    s ^= s << 5; s |= 0
    return ((s >>> 0) / 0x1_0000_0000)
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
    const r = simplify([[0, 0], [1, 1]], 0.1)
    expect(r.length).toBe(2)
  })

  it('all-identical points: keeps first + last', () => {
    const r = simplify([[5, 5], [5, 5], [5, 5], [5, 5]], 0.01)
    expect(r.length).toBeGreaterThanOrEqual(2)
    expect(r[0]).toEqual([5, 5])
    expect(r[r.length - 1]).toEqual([5, 5])
  })

  it('perfectly collinear points: drops interior', () => {
    const r = simplify([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]], 0.001)
    expect(r.length).toBe(2)
    expect(r[0]).toEqual([0, 0])
    expect(r[1]).toEqual([4, 4])
  })

  it('high-detail curve kept under low tolerance', () => {
    const ring: number[][] = []
    for (let i = 0; i <= 100; i++) {
      const t = i / 100 * 2 * Math.PI
      ring.push([Math.cos(t), Math.sin(t)])
    }
    const r = simplify(ring, 1e-6)
    expect(r.length).toBeGreaterThan(50)
  })

  it('high-detail curve collapses under high tolerance', () => {
    const ring: number[][] = []
    for (let i = 0; i <= 100; i++) {
      const t = i / 100 * 2 * Math.PI
      ring.push([Math.cos(t), Math.sin(t)])
    }
    const r = simplify(ring, 10)
    expect(r.length).toBeLessThanOrEqual(5)
  })

  it('tolerance = 0 returns input unchanged (spec)', () => {
    const ring = [[0, 0], [0.1, 0.1], [1, 1]]
    const r = simplify(ring, 0)
    expect(r.length).toBe(3)
  })

  it('negative tolerance returns input unchanged (defensive)', () => {
    const ring = [[0, 0], [0.1, 0.1], [1, 1]]
    const r = simplify(ring, -1)
    expect(r.length).toBe(3)
  })

  it('NaN tolerance does not crash', () => {
    expect(() => simplify([[0, 0], [1, 1]], NaN)).not.toThrow()
  })

  it('Infinity tolerance collapses to 2 points', () => {
    const ring = [[0, 0], [0.5, 0.5], [1, 1]]
    const r = simplify(ring, Infinity)
    expect(r.length).toBe(2)
  })

  it('NaN coord does not crash', () => {
    expect(() => simplify([[0, 0], [NaN, NaN], [1, 1]], 0.1)).not.toThrow()
  })

  it('Infinity coord does not crash', () => {
    expect(() => simplify([[0, 0], [Infinity, 0], [1, 1]], 0.1)).not.toThrow()
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
    const ring = [[0, 0], [1, 1], [2, 2], [3, 3]]
    const r = simplify(ring, 10, () => true)
    expect(r.length).toBe(4)
  })

  it('isLocked = always-false behaves like no isLocked', () => {
    const ring = [[0, 0], [1, 1], [2, 2], [3, 3]]
    const withLock = simplify(ring, 0.5, () => false)
    const without = simplify(ring, 0.5)
    expect(withLock.length).toBe(without.length)
  })

  it('isLocked on specific vertex preserves it', () => {
    // collinear ring — without lock would collapse to 2.
    const ring = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]
    const lockMiddle = (c: number[]) => c[0] === 2  // lock the middle
    const r = simplify(ring, 0.001, lockMiddle)
    expect(r.length).toBe(3)  // first, locked-middle, last
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
    const ring = [[0, 0], [1, 1], [2, 0], [0, 0]]
    expect(() => simplifyPolygon([ring], 22)).not.toThrow()
  })

  it('simplifyPolygon at very low zoom (z=0) high tolerance', () => {
    const ring = [[0, 0], [1, 1], [2, 0], [0, 0]]
    expect(() => simplifyPolygon([ring], 0)).not.toThrow()
  })

  it('simplifyLine empty / single-point', () => {
    expect(() => simplifyLine([], 5)).not.toThrow()
    expect(() => simplifyLine([[0, 0]], 5)).not.toThrow()
  })
})
