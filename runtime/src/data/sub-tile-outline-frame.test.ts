// Regression: synthetic-frame outline strokes survive into over-zoom
// sub-tiles ("vertical line through Russia"). SubTileGenerator clips a
// parent tile's geometry into a virtual child past archive maxLevel.
// The parent's `polygons` rings are ABSOLUTE Mercator metres and carry
// the axis-aligned synthetic edges Sutherland-Hodgman added when the
// parent itself was clipped to its own tile rect (e.g. a fill edge along
// a parent's east boundary). extractNonSyntheticArcs must drop those so
// the over-zoom outline doesn't draw a stroke along the parent clip edge.
//
// The fix is three-fold inside the outline-frame block of generate():
//   1. build the synthetic-edge predicate in ABSOLUTE MM (it was anchored
//      at parent-local (0,0), so it never matched the absolute ring X and
//      was effectively dead — the synthetic edges leaked through);
//   2. augment the extracted arcs with { mmInput: true } (the rings are
//      already MM — without it the metre coords were reprojected as
//      degrees and the MM-rect clip dropped every segment → empty
//      outlines, which masked the dead predicate);
//   3. drop the closing wrap augmentRingWithArc re-adds when that wrap is
//      itself a synthetic parent-boundary edge (re-introducing the edge
//      the extractor just removed).
//
// Assertion style mirrors compiler/src/__tests__/countries-boundary-tile-
// clip.test.ts: decode the stride-10 outline vertices, reconstruct
// absolute MM, and count segments running along the parent clip edge.

import { describe, it, expect } from 'vitest'
import { SubTileGenerator } from './sub-tile-generator'
import type { TileData } from './tile-types'
import {
  decomposeFeatures, compileSingleTile, tileKey, lonLatToMercF64,
} from '@xgis/compiler'
import type { GeoJSONFeature } from '@xgis/compiler'

/** Web-Mercator tile bounds in degrees (tileBounds is internal to the
 *  compiler — reimplement the standard scheme here). */
function tileBoundsDeg(z: number, x: number, y: number): { west: number; south: number; east: number; north: number } {
  const n = Math.pow(2, z)
  const west = x / n * 360 - 180
  const east = (x + 1) / n * 360 - 180
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI
  return { west, south, east, north }
}

const poly = (coords: number[][][]): GeoJSONFeature => ({
  type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: coords },
})

/** Compile a polygon into a parent TileData and FORWARD the clipped
 *  `polygons` rings (the over-zoom outline path reads them). maxZoom = z
 *  so z == maxZoom skips simplifyPolygon and the clipped ring — with its
 *  synthetic axis-aligned east edge — is preserved verbatim. */
function makeParent(feature: GeoJSONFeature, z: number, x: number, y: number): TileData | null {
  const parts = decomposeFeatures([feature])
  const compiled = compileSingleTile(parts, z, x, y, z)
  if (!compiled) return null
  const b = tileBoundsDeg(z, x, y)
  return {
    vertices: compiled.vertices,
    dequantScale: compiled.dequantScale,
    dequantHalf: compiled.dequantHalf,
    indices: compiled.indices,
    lineVertices: compiled.lineVertices,
    lineIndices: compiled.lineIndices,
    outlineIndices: compiled.outlineIndices,
    tileWest: b.west,
    tileSouth: b.south,
    tileWidth: b.east - b.west,
    tileHeight: b.north - b.south,
    tileZoom: z,
    polygons: compiled.polygons,
  }
}

describe('SubTileGenerator outline-frame (synthetic parent-edge leak)', () => {
  it('over-zoom outline drops the synthetic parent east-clip edge', () => {
    // Parent z=3 x=5 (lon 45..90): east boundary at lon=90 is at ABSOLUTE
    // MM ≈ 10,018,754, while parentMx ≈ 5,009,377. A parent-LOCAL predicate
    // anchored at (0,0) would test the abs ring X (~10M) against a
    // local-east of ~5M and never match — the bug. The parent is NOT at
    // lon=-180, so the dead filter cannot be accidentally masked.
    const z = 3, x = 5, y = 2
    // Polygon spans lon 60..120, crossing the parent's east boundary
    // (lon=90). Sutherland-Hodgman clips it at lon=90, introducing a
    // synthetic vertical edge along the parent east rect.
    const parent = makeParent(poly([[[60, 45], [120, 45], [120, 60], [60, 60], [60, 45]]]), z, x, y)
    expect(parent).not.toBeNull()
    expect(parent!.polygons, 'parent must forward clipped rings for the over-zoom outline path').toBeDefined()

    // Sub-tile z=5 x=23 (lon 78.75..90): its east edge coincides with the
    // parent east edge (lon=90), so a leaked synthetic stroke would land
    // exactly on this sub-tile's east boundary.
    const subZ = 5, subX = 23, subY = 11
    const sub = new SubTileGenerator().generate(parent!, tileKey(subZ, subX, subY))
    expect(sub).not.toBeNull()

    const olv = sub!.outlineVertices
    const oli = sub!.outlineLineIndices
    // The over-zoom outline path must actually emit the polygon's REAL
    // edges that fall inside this sub-tile (the south edge at lat=45). If
    // it emits nothing, the test below is vacuously true — guard it.
    expect(olv, 'over-zoom outline should emit the polygon real edges').toBeDefined()
    expect(oli, 'over-zoom outline should emit segment indices').toBeDefined()

    // outlineVertices are DSFUN stride-10, local to the SUB-tile origin
    // (subMxW, subMyS). Reconstruct absolute MM via subWestMx + mx_h + mx_l.
    const subB = tileBoundsDeg(subZ, subX, subY)
    const subWestMx = lonLatToMercF64(subB.west, subB.south)[0]
    const parentEastMx = lonLatToMercF64(tileBoundsDeg(z, x, y).east, 0)[0]

    const STRIDE = 10
    const EPS_MM = 200 // metres — parentEastMx is exact in float64
    let segmentsOnParentEastEdge = 0
    let totalSegments = 0
    for (let i = 0; i < oli!.length; i += 2) {
      const ia = oli![i]! * STRIDE
      const ib = oli![i + 1]! * STRIDE
      const ax = subWestMx + olv![ia]! + olv![ia + 2]!
      const bx = subWestMx + olv![ib]! + olv![ib + 2]!
      totalSegments++
      if (Math.abs(ax - parentEastMx) < EPS_MM && Math.abs(bx - parentEastMx) < EPS_MM) {
        segmentsOnParentEastEdge++
      }
    }

    // Real edges of the polygon inside this sub-tile must render…
    expect(totalSegments, 'outline should contain the polygon real edges').toBeGreaterThan(0)
    // …but NONE may run along the parent east clip edge (the synthetic
    // Sutherland-Hodgman frame edge). On unpatched code the predicate is
    // dead (and the wrap re-adds the edge), so this count is > 0 — the
    // user-visible vertical-line artifact.
    expect(segmentsOnParentEastEdge, 'no outline segment may run along the parent east clip edge').toBe(0)
  })
})
