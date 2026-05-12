// Targeted unit tests for clipPolygonToRect — pinning the cases the
// 2026-05-12 GeoJSON dropout bug puts pressure on. Specifically:
//
//   * polygon ENTIRELY CONTAINS rect (no ring vertices inside) → must
//     output the rect (4 corners). This is the case Natural Earth's
//     ocean hits when zoomed to the Yellow Sea: outer ring vertices
//     are kilometers away, but the polygon covers the tile.
//   * polygon barely overlaps rect (one corner) → must output the
//     overlap region.
//   * polygon entirely outside → must output [].
//
// If the "contains" case returns [] (the suspected bug), the dropout
// pattern in the user's screenshot is fully explained.

import { describe, it, expect } from 'vitest'
import { clipPolygonToRect } from './clip'

describe('clipPolygonToRect — polygon containment behaviour (Yellow Sea bug)', () => {
  // Standard tile rect: a 2×2 square at origin.
  const W = -1, S = -1, E = 1, N = 1

  it('big square containing rect → rect 4 corners', () => {
    // Polygon: (-10,-10) → (10,-10) → (10,10) → (-10,10) → close.
    // Every vertex is FAR OUTSIDE the rect (no vertex inside).
    // The rect is entirely INSIDE the polygon.
    const ring = [
      [-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10],
    ]
    const out = clipPolygonToRect([ring], W, S, E, N)
    expect(out).toHaveLength(1)
    expect(out[0].length).toBeGreaterThanOrEqual(4)
    // Output should describe (approximately) the rect — check bounds.
    let outMinX = Infinity, outMaxX = -Infinity, outMinY = Infinity, outMaxY = -Infinity
    for (const [x, y] of out[0]) {
      if (x < outMinX) outMinX = x; if (x > outMaxX) outMaxX = x
      if (y < outMinY) outMinY = y; if (y > outMaxY) outMaxY = y
    }
    expect(outMinX).toBeCloseTo(W, 6)
    expect(outMaxX).toBeCloseTo(E, 6)
    expect(outMinY).toBeCloseTo(S, 6)
    expect(outMaxY).toBeCloseTo(N, 6)
  })

  it('elongated horizontal rect containing tile → rect 4 corners', () => {
    // Like an "ocean ribbon" stretching across the world: spans from
    // very far west to very far east, with limited N-S extent.
    const ring = [
      [-180, -5], [180, -5], [180, 5], [-180, 5], [-180, -5],
    ]
    const out = clipPolygonToRect([ring], W, S, E, N)
    expect(out).toHaveLength(1)
    expect(out[0].length).toBeGreaterThanOrEqual(4)
  })

  it('one corner of the polygon is inside the rect → produces a sliver', () => {
    // Polygon entirely in the +X/+Y half, one corner pokes into the
    // rect.
    const ring = [
      [0.5, 0.5], [5, 0.5], [5, 5], [0.5, 5], [0.5, 0.5],
    ]
    const out = clipPolygonToRect([ring], W, S, E, N)
    expect(out).toHaveLength(1)
    expect(out[0].length).toBeGreaterThanOrEqual(3)
  })

  it('polygon entirely outside rect → returns []', () => {
    const ring = [
      [10, 10], [20, 10], [20, 20], [10, 20], [10, 10],
    ]
    const out = clipPolygonToRect([ring], W, S, E, N)
    expect(out).toEqual([])
  })

  it('CW-wound ring containing rect → still emits rect (winding-order independent)', () => {
    // Same as the first test but reversed (clockwise winding).
    const ring = [
      [-10, -10], [-10, 10], [10, 10], [10, -10], [-10, -10],
    ]
    const out = clipPolygonToRect([ring], W, S, E, N)
    expect(out).toHaveLength(1)
    expect(out[0].length).toBeGreaterThanOrEqual(4)
  })

  it('unclosed ring (last !== first) containing rect → still emits rect', () => {
    // Some GeoJSON dialects don't repeat the first vertex at the end.
    // clipRingToEdge uses (i+1)%len so it traverses the implicit
    // closing edge regardless. Sanity-check that.
    const ring = [
      [-10, -10], [10, -10], [10, 10], [-10, 10],
    ]
    const out = clipPolygonToRect([ring], W, S, E, N)
    expect(out).toHaveLength(1)
    expect(out[0].length).toBeGreaterThanOrEqual(4)
  })
})

describe('clipPolygonToRect — Yellow Sea repro coordinates', () => {
  // Real-world scale: an ocean-shaped ring (vertices in Mercator
  // meters around a world-wrapping outer boundary) clipped to a z=7
  // tile rect over the Yellow Sea. This mirrors what compileSingleTile
  // does for Natural Earth's ocean polygon.
  it('Mercator-scale ring containing a z=7 sub-tile → produces tile rect', () => {
    const R = 6378137
    // z=7 tile at Korea (Incheon-ish): tile_x=109, tile_y=51
    // Bounds in lon/lat:
    //   west  ≈ 126.5625, east  ≈ 129.375
    //   north ≈ 37.43,    south ≈ 35.46
    // Convert to Mercator meters (Web Mercator):
    const tileW = 126.5625 * Math.PI / 180 * R
    const tileE = 129.375 * Math.PI / 180 * R
    const tileN = Math.log(Math.tan(Math.PI / 4 + 37.43 * Math.PI / 360)) * R
    const tileS = Math.log(Math.tan(Math.PI / 4 + 35.46 * Math.PI / 360)) * R

    // Ocean ring: a "world-wrapping" ring far outside this tile.
    const worldMin = -180 * Math.PI / 180 * R
    const worldMax = 180 * Math.PI / 180 * R
    const yMin = Math.log(Math.tan(Math.PI / 4 + -60 * Math.PI / 360)) * R
    const yMax = Math.log(Math.tan(Math.PI / 4 + 60 * Math.PI / 360)) * R
    const ring = [
      [worldMin, yMin], [worldMax, yMin], [worldMax, yMax],
      [worldMin, yMax], [worldMin, yMin],
    ]

    const out = clipPolygonToRect([ring], tileW, tileS, tileE, tileN)
    expect(out, 'world-wrapping ocean ring should produce a rect for tiles inside it').toHaveLength(1)
    if (out.length > 0) {
      expect(out[0].length).toBeGreaterThanOrEqual(4)
    }
  })
})
