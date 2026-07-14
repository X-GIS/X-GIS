import { describe, expect, it } from 'vitest'
import { lonLatToMercF64, tileKey } from '@xgis/compiler'
import { type TileData } from './tile-types'
import { SubTileGenerator } from './sub-tile-generator'

// #1082 — over-zoom sub-tiles must forward the parent's extrusion `polygons`
// CLIPPED to each sub-tile window, not the whole parent set. Before the fix
// every one of the 4 children carried ALL of the parent's polygons, so the
// extruded-building upload path re-extruded every building in every child →
// duplicate overlapping walls + z-fighting at deep zoom.
//
// This drives `SubTileGenerator.generate()` directly with a hand-built parent
// (empty fill — the clip under test is on the forwarded ring set, which the
// extrusion path consumes) whose `polygons` are three squares in absolute
// Mercator metres: two disjoint interior buildings (one per quadrant) plus one
// that straddles the vertical child boundary.

/** Tile lon/lat bounds — same Web-Mercator formulas SubTileGenerator uses. */
function tileLonLatBounds(
  z: number,
  x: number,
  y: number,
): { west: number; south: number; east: number; north: number } {
  const n = 2 ** z
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
    south: (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI,
  }
}

/** Axis-aligned square ring in absolute Mercator metres, built with the SAME
 *  projection the clip window is derived from so boundary math is exact. */
function mercSquare(lonMin: number, latMin: number, lonMax: number, latMax: number): number[][] {
  const [x0, y0] = lonLatToMercF64(lonMin, latMin)
  const [x1, y1] = lonLatToMercF64(lonMax, latMax)
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ]
}

// Parent z=2 tile (2,1): lon [0,90], lat [0,~66.51]. Its four z=3 children:
//   NW (4,2) lon[0,45]  lat[~41,~66.51]     NE (5,2) lon[45,90] lat[~41,~66.51]
//   SW (4,3) lon[0,45]  lat[0,~41]          SE (5,3) lon[45,90] lat[0,~41]
const PARENT = tileLonLatBounds(2, 2, 1)

function makeParent(): TileData {
  return {
    vertices: new Float32Array(0),
    dequantScale: 1,
    dequantHalf: 0,
    indices: new Uint32Array(0),
    lineVertices: new Float32Array(0),
    lineIndices: new Uint32Array(0),
    outlineIndices: new Uint32Array(0),
    tileWest: PARENT.west,
    tileSouth: PARENT.south,
    tileWidth: PARENT.east - PARENT.west,
    tileHeight: PARENT.north - PARENT.south,
    tileZoom: 2,
    polygons: [
      { rings: [mercSquare(10, 10, 20, 20)], featId: 1 }, // fully inside SW (4,3)
      { rings: [mercSquare(60, 50, 70, 60)], featId: 2 }, // fully inside NE (5,2)
      { rings: [mercSquare(40, 50, 50, 60)], featId: 3 }, // straddles NW|NE at lon=45
    ],
    heights: new Map([
      [1, 12],
      [2, 12],
      [3, 12],
    ]),
  }
}

const CHILDREN: Array<{ label: string; cx: number; cy: number; expected: number[] }> = [
  { label: 'NW', cx: 4, cy: 2, expected: [3] }, // straddle-left only
  { label: 'NE', cx: 5, cy: 2, expected: [2, 3] }, // interior B + straddle-right
  { label: 'SW', cx: 4, cy: 3, expected: [1] }, // interior A only
  { label: 'SE', cx: 5, cy: 3, expected: [] }, // nothing
]

describe('SubTileGenerator forwards parent polygons CLIPPED to the sub-tile window (#1082)', () => {
  it('each child carries exactly its own polygons, all rings bounded by its window', () => {
    const gen = new SubTileGenerator()
    const parent = makeParent()

    for (const { label, cx, cy, expected } of CHILDREN) {
      const result = gen.generate(parent, tileKey(3, cx, cy))
      expect(result, `${label}: generate returned null`).not.toBeNull()
      if (!result) continue

      const featIds = [...new Set((result.polygons ?? []).map((p) => p.featId))].sort(
        (a, b) => a - b,
      )
      expect(featIds, `${label} child should carry exactly ${JSON.stringify(expected)}`).toEqual(
        expected,
      )

      // Every kept ring vertex must lie within THIS child's absolute-MM window.
      const b = tileLonLatBounds(3, cx, cy)
      const [wX, sY] = lonLatToMercF64(b.west, b.south)
      const [eX, nY] = lonLatToMercF64(b.east, b.north)
      const eps = 1 // 1 m — clip snaps straddler vertices exactly onto the edge
      for (const poly of result.polygons ?? []) {
        for (const ring of poly.rings) {
          for (const [x, y] of ring) {
            expect(
              x,
              `${label} featId ${poly.featId} vertex x within window`,
            ).toBeGreaterThanOrEqual(wX - eps)
            expect(x).toBeLessThanOrEqual(eX + eps)
            expect(y).toBeGreaterThanOrEqual(sY - eps)
            expect(y).toBeLessThanOrEqual(nY + eps)
          }
        }
      }

      // featId-keyed height/base Maps are forwarded unchanged — the clip
      // preserves featId, so the same Map still resolves for clipped pieces.
      expect(result.heights, `${label}: heights Map forwarded`).toBe(parent.heights)
    }
  })

  it('the straddling square appears in BOTH children it crosses (never dropped, never whole)', () => {
    const gen = new SubTileGenerator()
    const parent = makeParent()

    const west = gen.generate(parent, tileKey(3, 4, 2)) // NW
    const east = gen.generate(parent, tileKey(3, 5, 2)) // NE
    expect(west).not.toBeNull()
    expect(east).not.toBeNull()

    const straddleWest = (west!.polygons ?? []).find((p) => p.featId === 3)
    const straddleEast = (east!.polygons ?? []).find((p) => p.featId === 3)
    expect(straddleWest, 'straddler present in NW child').toBeDefined()
    expect(straddleEast, 'straddler present in NE child').toBeDefined()

    // The lon=45 seam in absolute MM: the west piece stays at/below it, the
    // east piece at/above it.
    const [seamX] = lonLatToMercF64(45, 0)
    const westMaxX = Math.max(...straddleWest!.rings[0].map((p) => p[0]))
    const eastMinX = Math.min(...straddleEast!.rings[0].map((p) => p[0]))
    expect(westMaxX, 'west straddle piece bounded by the seam').toBeLessThanOrEqual(seamX + 1)
    expect(eastMinX, 'east straddle piece bounded by the seam').toBeGreaterThanOrEqual(seamX - 1)
  })
})
