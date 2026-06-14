// Antimeridian outline-seam repro (user-reported: id=minimal flat mercator
// z≈0.5 @ lon 175° shows a full-height vertical STROKE line at lon ±180,
// repeated in every world copy).
//
// Root cause (found via real-GPU bisect, NOT static analysis — the static
// guess was wrong): the polygon OUTLINE path line-clips each ORIGINAL ring
// with clipLineToRect (Liang-Barsky). Liang-Barsky is artifact-free for a
// CROSSING edge (it clips to the boundary point) — that case is covered by
// countries-boundary-tile-clip.test.ts. But it PRESERVES a source edge that
// lies COINCIDENT with a boundary, e.g. the dateline-split edges Natural
// Earth bakes at exactly lon ±180. Those get stroked → the seam line. The
// fill never shows it (interior). dropTileBoundaryEdges must drop edges with
// both endpoints on the same tile boundary.

import { describe, it, expect } from 'vitest'
import { decomposeFeatures, compileSingleTile, lonLatToMercF64 } from '../tiler/vector-tiler'

function tileBounds(z: number, x: number, y: number) {
  const n = 1 << z
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    south: (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI,
    north: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
  }
}

// A polygon whose RIGHT edge runs ALONG lon=180 — exactly the shape Natural
// Earth produces when it splits an antimeridian-crossing country at the
// dateline. The z=0 tile's east boundary IS lon=180.
const POLY = {
  type: 'Feature' as const,
  properties: {},
  geometry: {
    type: 'Polygon' as const,
    coordinates: [[[170, -10], [180, -10], [180, 10], [170, 10], [170, -10]]],
  },
}

describe('antimeridian outline seam', () => {
  it('outline of a polygon with an edge ALONG lon=180 does not stroke the antimeridian', () => {
    const z = 0, x = 0, y = 0
    const parts = decomposeFeatures([POLY])
    const tile = compileSingleTile(parts, z, x, y, 7)
    expect(tile, 'tile compiles').not.toBeNull()
    const olv = tile!.outlineVertices
    const oli = tile!.outlineLineIndices
    expect(olv && oli, 'has outline geometry').toBeTruthy()
    if (!olv || !oli) return

    const tb = tileBounds(z, x, y)
    const eastMx = lonLatToMercF64(tb.east, 0)[0] // lon 180 → +WORLD_MERC
    const tileWestMx = lonLatToMercF64(tb.west, 0)[0]

    // outline vertices stride-10: [mx_h, my_h, mx_l, my_l, arc, …]; absolute
    // mx = tileWest + mx_h + mx_l (DSFUN pair), mirroring the sibling
    // countries-boundary-tile-clip.test.ts decode.
    const STRIDE = 10
    const EPS_MM = 100
    let segmentsOnAntimeridian = 0
    for (let i = 0; i < oli.length; i += 2) {
      const ia = oli[i]! * STRIDE
      const ib = oli[i + 1]! * STRIDE
      const ax = tileWestMx + olv[ia]! + olv[ia + 2]!
      const bx = tileWestMx + olv[ib]! + olv[ib + 2]!
      if (Math.abs(ax - eastMx) < EPS_MM && Math.abs(bx - eastMx) < EPS_MM) {
        segmentsOnAntimeridian++
      }
    }
    expect(
      segmentsOnAntimeridian,
      'no outline segment may run along the lon=180 tile boundary (antimeridian seam)',
    ).toBe(0)
  })
})
