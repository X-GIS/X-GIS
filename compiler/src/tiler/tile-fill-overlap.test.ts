import { describe, it, expect } from 'vitest'
import { compileSingleTile, decomposeFeatures, FILL_TILE_OVERLAP_FRAC } from './vector-tiler'
import { lonLatToMercF64 } from './ecef-packing'
import type { GeoJSONFeature } from './geojson-types'

// Inter-tile fill overlap (seam fix). Adjacent same-layer fill tiles must
// OVERLAP past their shared boundary, not abut at an exact edge — an exact
// abutment is what 4× MSAA renders as a background-bleed hairline on the globe.
//
// fail-before (exact clip): each tile's fill stops exactly on the shared
// meridian, so there is zero overlap (maxX(A) == sharedX == minX(B)).
// pass-after (widened clip): A extends east past the meridian and B extends
// west past it, each by ~FILL_TILE_OVERLAP_FRAC of the tile span.

function tileBoundsLL(z: number, x: number, y: number) {
  const n = 2 ** z
  return {
    west: x / n * 360 - 180,
    east: (x + 1) / n * 360 - 180,
    south: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI,
    north: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI,
  }
}

function rectFeature(west: number, south: number, east: number, north: number): GeoJSONFeature {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    },
  } as GeoJSONFeature
}

function ringExtentMercX(tile: { polygons?: { rings: number[][][] }[] } | null): { min: number; max: number } {
  let min = Infinity, max = -Infinity
  for (const p of tile?.polygons ?? []) {
    for (const ring of p.rings) {
      for (const v of ring) {
        if (v[0]! < min) min = v[0]!
        if (v[0]! > max) max = v[0]!
      }
    }
  }
  return { min, max }
}

describe('adjacent fill tiles overlap past the shared boundary (MSAA seam fix)', () => {
  it('tile A extends east and tile B extends west past the shared meridian', () => {
    const z = 5, ax = 20, bx = 21, y = 15, maxZoom = 14
    const tbA = tileBoundsLL(z, ax, y)
    const tbB = tileBoundsLL(z, bx, y)
    const sharedLon = tbA.east // == tbB.west
    expect(sharedLon).toBeCloseTo(tbB.west, 9)

    const sharedMx = lonLatToMercF64(sharedLon, 0)[0]
    const spanMx = lonLatToMercF64(tbB.east, 0)[0] - lonLatToMercF64(tbB.west, 0)[0]
    const margin = spanMx * FILL_TILE_OVERLAP_FRAC

    // A rectangle straddling the shared meridian, well inside the tile row in
    // latitude and reaching a couple of degrees either side of the meridian —
    // covers the east strip of A and the west strip of B (neither full-cover).
    const feat = rectFeature(sharedLon - 3, tbA.south + 2, sharedLon + 3, tbA.north - 2)
    const parts = decomposeFeatures([feat])

    const tileA = compileSingleTile(parts, z, ax, y, maxZoom)
    const tileB = compileSingleTile(parts, z, bx, y, maxZoom)
    expect(tileA, 'tile A must compile').not.toBeNull()
    expect(tileB, 'tile B must compile').not.toBeNull()

    const extA = ringExtentMercX(tileA)
    const extB = ringExtentMercX(tileB)

    // A's fill reaches EAST past the shared meridian by ~margin (into B's side).
    expect(extA.max - sharedMx, 'tile A fill overlaps east past the shared boundary')
      .toBeGreaterThanOrEqual(margin * 0.9)
    // B's fill reaches WEST past the shared meridian by ~margin (into A's side).
    expect(sharedMx - extB.min, 'tile B fill overlaps west past the shared boundary')
      .toBeGreaterThanOrEqual(margin * 0.9)
  })
})
