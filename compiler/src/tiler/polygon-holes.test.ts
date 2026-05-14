// ═══════════════════════════════════════════════════════════════════
// Polygon hole preservation through the tiler pipeline
// ═══════════════════════════════════════════════════════════════════
//
// Tracks down the demotiles z=9.45 China visual regression
// (project_demotiles_polygon_hole.md):
//
//   MapLibre renders countries-fill polygons WITH interior rings
//   (lakes, river-cut regions) as holes — background shows through.
//   X-GIS renders the same polygons FILLED across the hole regions —
//   the river area gets painted with the country's fill colour.
//
// Hypothesis: somewhere between `decomposeFeatures` and
// `compileSingleTile`'s triangulation, the interior rings get
// dropped or treated as additional outers.
//
// Each test isolates a stage:
//
//   1. `decomposeFeatures` preserves ring count
//   2. `compileSingleTile` keeps the hole-bearing polygon's rings
//      intact when no boundary-split occurs (the common path)
//   3. Triangle count REDUCES when holes are present (proves earcut
//      ran with holeIndices, not just on the outer)

import { describe, expect, it } from 'vitest'
import { decomposeFeatures, compileSingleTile } from './vector-tiler'
import type { GeoJSONFeature } from './geojson-types'

/** Build a square donut polygon (outer 4×4 square with a 2×2 hole)
 *  centred at (lon, lat). Both rings closed (last = first). */
function makeDonut(lon: number, lat: number): GeoJSONFeature {
  const outer = [
    [lon - 2, lat - 2], [lon + 2, lat - 2],
    [lon + 2, lat + 2], [lon - 2, lat + 2],
    [lon - 2, lat - 2],
  ]
  const hole = [
    [lon - 1, lat - 1], [lon + 1, lat - 1],
    [lon + 1, lat + 1], [lon - 1, lat + 1],
    [lon - 1, lat - 1],
  ]
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [outer, hole] },
  }
}

function makeSolidSquare(lon: number, lat: number): GeoJSONFeature {
  const outer = [
    [lon - 2, lat - 2], [lon + 2, lat - 2],
    [lon + 2, lat + 2], [lon - 2, lat + 2],
    [lon - 2, lat - 2],
  ]
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [outer] },
  }
}

describe('decomposeFeatures', () => {
  it('preserves ring count for a polygon with a hole', () => {
    const parts = decomposeFeatures([makeDonut(0, 0)])
    expect(parts).toHaveLength(1)
    const p = parts[0] as { type: string; rings: number[][][] }
    expect(p.type).toBe('polygon')
    expect(p.rings).toHaveLength(2)
    expect(p.rings[0]).toHaveLength(5)
    expect(p.rings[1]).toHaveLength(5)
  })

  it('preserves ring count for MultiPolygon with hole in one part', () => {
    const feature: GeoJSONFeature = {
      type: 'Feature', properties: {},
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          // Part 1: solid square at (-10, 0)
          [[
            [-12, -2], [-8, -2], [-8, 2], [-12, 2], [-12, -2],
          ]],
          // Part 2: donut at (10, 0)
          [
            [[8, -2], [12, -2], [12, 2], [8, 2], [8, -2]],
            [[9, -1], [11, -1], [11, 1], [9, 1], [9, -1]],
          ],
        ],
      },
    }
    const parts = decomposeFeatures([feature])
    expect(parts).toHaveLength(2)
    const ringCounts = (parts as Array<{ rings: unknown[] }>).map(p => p.rings.length)
    expect(ringCounts.sort()).toEqual([1, 2])
  })
})

describe('compileSingleTile — hole preservation', () => {
  // The donut is centred at lon=0, lat=0 with ±2° extent. Tile z=2/(1,1)
  // is the NW quadrant of the northern hemisphere; (2,1) is NE quadrant.
  // The polygon straddles the prime meridian + equator, hitting all
  // four z=2 tiles. Use z=0/0/0 which covers the whole world — the
  // polygon fits cleanly inside and won't trigger boundary-split
  // repair.

  it('compileSingleTile produces non-zero triangulation for in-tile donut', () => {
    const parts = decomposeFeatures([makeDonut(0, 0)])
    const tile = compileSingleTile(parts, 0, 0, 0, 0)
    expect(tile).not.toBeNull()
    // CompiledTile.indices is Uint32Array of polygon triangle indices.
    expect(tile!.indices.length).toBeGreaterThan(0)
  })

  it('donut crossing the tile boundary KEEPS holes (regression: vector-tiler.ts:1566)', () => {
    // The boundary-backtrack-repair branch at line 1566 splits the
    // outer ring into multiple sub-outers when the polygon hugs a
    // tile boundary and back-tracks on it. Pre-fix, holes were
    // DROPPED entirely in this branch with the comment "rare (Korea
    // z=7 had no holes)" — but demotiles countries-fill DOES have
    // hole-bearing polygons that cross tile boundaries (the Yangtze
    // river area on the China polygon at z=9, etc.). When holes get
    // dropped, the polygon fills the river area with the country
    // colour, producing the 1886-pixel visual mismatch documented
    // in project_demotiles_polygon_hole.md.
    //
    // This test builds a donut at the equator + prime meridian, then
    // compiles into a tile that contains the WEST HALF of the donut.
    // The outer crosses the tile's east edge, triggering boundary
    // repair. With the fix, the hole survives → triangulation has
    // MORE indices than the solid-half equivalent. Without (broken)
    // → triangulation = solid-half-only count.
    const donut = makeDonut(0, 0)
    const solid = makeSolidSquare(0, 0)
    // Tile z=1/0/0 covers lon=[-180, 0], lat=[0, 85]. Donut at (0,0)
    // straddles the east boundary at lon=0 with outer ring ±2 and
    // hole ±1 — both rings cross.
    const donutParts = decomposeFeatures([donut])
    const solidParts = decomposeFeatures([solid])
    const donutTile = compileSingleTile(donutParts, 1, 0, 0, 1)
    const solidTile = compileSingleTile(solidParts, 1, 0, 0, 1)
    const donutIndices = donutTile?.indices.length ?? 0
    const solidIndices = solidTile?.indices.length ?? 0
    expect(solidIndices).toBeGreaterThan(0)
    expect(donutIndices).toBeGreaterThan(solidIndices)
  })

  it('hole-bearing donut produces MORE triangle indices than solid square', () => {
    // Both polygons go through the same per-tile pipeline (clip +
    // simplify + globe subdivision + earcut). The donut shares the
    // same outer ring as the solid square; the extra triangles come
    // from the hole's perimeter being incorporated into the
    // triangulation (earcut links hole vertices into the outer's
    // ear-clipping path, producing a strip around the hole). If the
    // hole were DROPPED, the donut would triangulate identically to
    // the solid → same index count. If holes were treated as
    // separate outers, both rings would tessellate independently
    // and the donut would have ≈2× the solid count.
    //
    // Earcut with respected hole produces "donut count > solid count"
    // by the hole-perimeter contribution. The exact ratio depends on
    // the globe-subdivision factor (z=0 over-subdivides for projection
    // accuracy), so the assertion is just the structural inequality.
    const donutParts = decomposeFeatures([makeDonut(0, 0)])
    const solidParts = decomposeFeatures([makeSolidSquare(0, 0)])
    const donutTile = compileSingleTile(donutParts, 0, 0, 0, 0)
    const solidTile = compileSingleTile(solidParts, 0, 0, 0, 0)
    const donutIndices = donutTile?.indices.length ?? 0
    const solidIndices = solidTile?.indices.length ?? 0
    expect(solidIndices).toBeGreaterThan(0)
    expect(donutIndices).toBeGreaterThan(solidIndices)
  })
})
