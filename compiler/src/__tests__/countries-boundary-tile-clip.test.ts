// Repro for user-reported demotiles z=3.19 vertical-line artifact.
// countries-boundary (type:line on polygon source "countries") emits
// visible stroke segments along tile boundaries that no real country
// border follows. Compile a synthetic polygon spanning a tile boundary
// and verify the resulting outline segments don't include the
// tile-edge-coincident segment.

import { describe, it, expect } from 'vitest'
import {
  decomposeFeatures, compileSingleTile, lonLatToMercF64,
} from '../tiler/vector-tiler'

// tileBounds is internal to vector-tiler.ts. Reimplement the public
// formula here — `tile.bounds` is the standard Web Mercator scheme.
function tileBounds(z: number, x: number, y: number) {
  const n = 1 << z
  const west = x / n * 360 - 180
  const east = (x + 1) / n * 360 - 180
  const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI
  const latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI
  return { west, south: latS, east, north: latN }
}

// Polygon spanning lon=42° to lon=48° (crosses the z=4 lon=45° tile
// boundary at x=9/x=10). Latitude band 48°-52° fully inside z=4 tile
// y=5 (which spans lat ~40.98° to lat 55.78°).
const POLY = {
  type: 'Feature' as const,
  geometry: {
    type: 'Polygon' as const,
    coordinates: [[
      [42, 48], [48, 48], [48, 52], [42, 52], [42, 48],
    ]],
  },
  properties: {},
}

describe('countries-boundary tile-clip artifact (demotiles repro)', () => {
  it('outline of a polygon spanning lon=45° tile boundary does NOT include the boundary segment', () => {
    // z=4 tile x=9 covers lon 22.5° to 45° (eastern edge at lon=45°).
    const z = 4, x = 9, y = 5
    const parts = decomposeFeatures([POLY])
    const tile = compileSingleTile(parts, z, x, y, 7)
    expect(tile).not.toBeNull()
    const olv = tile!.outlineVertices
    expect(olv, 'should have outline vertices').toBeDefined()
    if (!olv) return

    // The eastern edge of tile x=9 is at lon=45°, which in MM is:
    const tb = tileBounds(z, x, y)
    const eastMx = lonLatToMercF64(tb.east, 0)[0]

    // outline vertices stride-10: [mx_h, my_h, mx_l, my_l, arc, tinX, tinY, toutX, toutY, _].
    // Reconstruct mx by mx_h + mx_l (DSFUN pair). Tile-local: vertices are
    // relative to (tileWest, tileSouth) in MM. Convert to absolute MM:
    const tileWestMx = lonLatToMercF64(tb.west, 0)[0]

    const STRIDE = 10
    let segmentsOnEastEdge = 0
    const EPS_MM = 100  // 100m tolerance — eastMx is exact in float64
    const segments: Array<{ ax: number; bx: number }> = []
    const oli = tile!.outlineLineIndices
    if (oli) {
      for (let i = 0; i < oli.length; i += 2) {
        const ia = oli[i]! * STRIDE
        const ib = oli[i + 1]! * STRIDE
        const ax = tileWestMx + olv[ia]! + olv[ia + 2]!
        const bx = tileWestMx + olv[ib]! + olv[ib + 2]!
        segments.push({ ax, bx })
        if (Math.abs(ax - eastMx) < EPS_MM && Math.abs(bx - eastMx) < EPS_MM) {
          segmentsOnEastEdge++
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[tile-clip] tile x=${x}: ${segments.length} outline segments, ${segmentsOnEastEdge} along east edge (mx=${eastMx.toFixed(0)})`)

    // The real polygon has 4 edges: bottom (lon 42→48 at lat=48),
    // right (lat 48→52 at lon=48), top (lon 48→42 at lat=52), left
    // (lat 52→48 at lon=42). When clipped to tile x=9 (lon 22.5..45°)
    // the right edge (lon=48) is OUTSIDE the tile and gets clipped to
    // lon=45°. The clipped polygon picks up a synthetic edge running
    // along lon=45° (eastMx in MM) between the entry/exit points.
    // extractNonSyntheticArcs MUST filter this synthetic edge — if it
    // doesn't, segmentsOnEastEdge > 0 and the user sees a visible
    // tile-clip artifact (the original bug).
    expect(segmentsOnEastEdge, 'no outline segments should run along the tile clip edge').toBe(0)
  })

  it('outline for the EAST half (tile x=10) also lacks west-edge segments', () => {
    const z = 4, x = 10, y = 5
    const parts = decomposeFeatures([POLY])
    const tile = compileSingleTile(parts, z, x, y, 7)
    if (!tile) return
    const olv = tile.outlineVertices
    const oli = tile.outlineLineIndices
    if (!olv || !oli) return
    const tb = tileBounds(z, x, y)
    const tileWestMx = lonLatToMercF64(tb.west, 0)[0]
    const westMx = tileWestMx  // tile x=10's west edge IS lon=45°

    const STRIDE = 10
    let segmentsOnWestEdge = 0
    for (let i = 0; i < oli.length; i += 2) {
      const ia = oli[i]! * STRIDE
      const ib = oli[i + 1]! * STRIDE
      const ax = tileWestMx + olv[ia]! + olv[ia + 2]!
      const bx = tileWestMx + olv[ib]! + olv[ib + 2]!
      if (Math.abs(ax - westMx) < 100 && Math.abs(bx - westMx) < 100) {
        segmentsOnWestEdge++
      }
    }
    expect(segmentsOnWestEdge).toBe(0)
  })
})
