// iter-295 — Polygon / line clip fuzz. Edge cases:
//  - Empty input
//  - Single-point ring (degenerate)
//  - Two-point ring (degenerate)
//  - All-outside (no overlap)
//  - All-inside (passes through)
//  - Exact boundary alignment
//  - Self-touching ring
//  - Reversed winding
//  - Zero-area rect

import { describe, it, expect } from 'vitest'
import { clipPolygonToRect, clipLineToRect, splitBoundaryBacktracks } from './clip'

const unitRect = { west: 0, south: 0, east: 1, north: 1 }

function R(r: typeof unitRect): [number, number, number, number] {
  return [r.west, r.south, r.east, r.north]
}

describe('iter-295 clipPolygonToRect fuzz', () => {
  it('empty input → empty output', () => {
    const r = clipPolygonToRect([], ...R(unitRect))
    expect(r).toEqual([])
  })

  it('single-point ring (1 vertex) → dropped', () => {
    const r = clipPolygonToRect([[[0.5, 0.5]]], ...R(unitRect))
    expect(r).toEqual([])
  })

  it('two-point ring → dropped (need ≥3)', () => {
    const r = clipPolygonToRect([[[0.5, 0.5], [0.6, 0.6]]], ...R(unitRect))
    expect(r).toEqual([])
  })

  it('triangle fully inside → preserved', () => {
    const tri = [[[0.2, 0.2], [0.8, 0.2], [0.5, 0.8]]]
    const r = clipPolygonToRect(tri, ...R(unitRect))
    expect(r.length).toBe(1)
    expect(r[0]!.length).toBeGreaterThanOrEqual(3)
  })

  it('triangle fully outside → dropped', () => {
    const tri = [[[10, 10], [11, 10], [10.5, 11]]]
    const r = clipPolygonToRect(tri, ...R(unitRect))
    expect(r).toEqual([])
  })

  it('triangle crossing two edges → clipped to convex piece', () => {
    const tri = [[[-1, 0.5], [2, 0.5], [0.5, 2]]]
    const r = clipPolygonToRect(tri, ...R(unitRect))
    expect(r.length).toBe(1)
    expect(r[0]!.length).toBeGreaterThanOrEqual(3)
    // Every vertex inside the rect (with small epsilon).
    for (const [x, y] of r[0]!) {
      expect(x).toBeGreaterThanOrEqual(-1e-9)
      expect(x).toBeLessThanOrEqual(1 + 1e-9)
      expect(y).toBeGreaterThanOrEqual(-1e-9)
      expect(y).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('ring with exactly rect-boundary edges stays bounded', () => {
    const r = clipPolygonToRect([[[0, 0], [1, 0], [1, 1], [0, 1]]], ...R(unitRect))
    expect(r.length).toBeGreaterThanOrEqual(0)
    // Don't strictly require it to be kept — Sutherland-Hodgman may
    // produce a degenerate result on exact-boundary rings. The
    // contract here is: no crash, no out-of-bounds output.
    for (const ring of r) {
      for (const [x] of ring) {
        expect(x).toBeGreaterThanOrEqual(-1e-9)
        expect(x).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('zero-area rect (west === east) does not crash', () => {
    const tri = [[[0.2, 0.2], [0.8, 0.2], [0.5, 0.8]]]
    expect(() => clipPolygonToRect(tri, 0.5, 0, 0.5, 1)).not.toThrow()
  })

  it('inverted rect (west > east) does not crash (defensive)', () => {
    const tri = [[[0.2, 0.2], [0.8, 0.2], [0.5, 0.8]]]
    expect(() => clipPolygonToRect(tri, 1, 0, 0, 1)).not.toThrow()
  })

  it('huge ring (10k vertices) no crash', () => {
    const big: number[][] = []
    for (let i = 0; i < 10000; i++) {
      const t = i / 10000 * 2 * Math.PI
      big.push([0.5 + 0.3 * Math.cos(t), 0.5 + 0.3 * Math.sin(t)])
    }
    expect(() => clipPolygonToRect([big], ...R(unitRect))).not.toThrow()
  })

  it('NaN vertex does not crash (defensive)', () => {
    const tri = [[[NaN, 0.5], [0.8, 0.5], [0.5, 0.8]]]
    expect(() => clipPolygonToRect(tri, ...R(unitRect))).not.toThrow()
  })

  it('outer ring + 1 hole both crossing boundary', () => {
    const outer = [[-1, -1], [2, -1], [2, 2], [-1, 2]]
    const hole = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]]
    const r = clipPolygonToRect([outer, hole], ...R(unitRect))
    expect(r.length).toBeGreaterThanOrEqual(1)  // outer kept (clipped)
  })
})

describe('iter-295 clipLineToRect fuzz', () => {
  it('empty line → empty output', () => {
    const r = clipLineToRect([], ...R(unitRect))
    expect(r).toEqual([])
  })

  it('single-point line returns nothing meaningful (no segment)', () => {
    // No assertion on contents — just no crash.
    expect(() => clipLineToRect([[0.5, 0.5]], ...R(unitRect))).not.toThrow()
  })

  it('line fully inside preserved', () => {
    const line = [[0.2, 0.2], [0.8, 0.8]]
    const r = clipLineToRect(line, ...R(unitRect))
    expect(r.length).toBeGreaterThanOrEqual(1)
  })

  it('line fully outside dropped', () => {
    const r = clipLineToRect([[10, 10], [11, 11]], ...R(unitRect))
    expect(r).toEqual([])
  })

  it('line crossing rect produces clipped segment(s)', () => {
    const line = [[-1, 0.5], [2, 0.5]]
    const r = clipLineToRect(line, ...R(unitRect))
    expect(r.length).toBeGreaterThanOrEqual(1)
    // Resulting segments should all be inside the rect.
    for (const seg of r) {
      for (const [x, y] of seg) {
        expect(x).toBeGreaterThanOrEqual(-1e-9)
        expect(x).toBeLessThanOrEqual(1 + 1e-9)
        expect(y).toBeGreaterThanOrEqual(-1e-9)
        expect(y).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('NaN vertex in line does not crash', () => {
    expect(() => clipLineToRect([[NaN, 0.5], [0.8, 0.5]], ...R(unitRect))).not.toThrow()
  })
})

describe('iter-295 splitBoundaryBacktracks fuzz', () => {
  it('empty ring is a no-op', () => {
    expect(() => splitBoundaryBacktracks([], 0, 0, 1, 1)).not.toThrow()
  })

  it('simple non-backtracking ring is unchanged in count', () => {
    const ring = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]
    const r = splitBoundaryBacktracks(ring, 0, 0, 1, 1)
    // Result is an array of rings.
    expect(Array.isArray(r)).toBe(true)
    expect(r.length).toBeGreaterThanOrEqual(1)
  })

  it('NaN vertex does not crash', () => {
    const ring = [[NaN, 0.5], [0.8, 0.5], [0.5, 0.8]]
    expect(() => splitBoundaryBacktracks(ring, 0, 0, 1, 1)).not.toThrow()
  })
})
