// Repro for #2550 — the inline tiler gave LineStrings a seam story
// (`pushPartWithWrap`, #1221 round 2 / #2547) and polygons none. Two failures,
// both measured end to end at z2 through the real entry points
// (`decomposeFeatures` → `compileSingleTile`), on a 20°-wide box at lat −10…10:
//
//   authored 170 … 190  (past the seam)  → fill in z2 x3 ONLY, 567 vertices —
//                                          the 180…190 half existed in no tile
//   authored 170 … −170 (folded, the common GeoJSON shape)
//                                        → fill in ALL FOUR z2 columns,
//                                          4319 vertices each: a 20° box
//                                          painted across the whole equator
//
// The oracle for both is the same box straddling an ORDINARY tile edge
// (80…100 straddles the z2 x2|x3 boundary at lon 90). The seam is a tile edge
// like any other once the ring is on one 360° branch and the beyond-seam half
// is emitted as the ±360 world copy the renderer draws at world-copy ±1
// (ADR-0006) — so the seam-crossing box must tile EXACTLY like that control,
// tile for tile and vertex for vertex.
//
// (Note the control is NOT the 1519 vertices of a box that fits inside one
// tile: any 20° box straddling a tile edge tessellates to 567 + 567. The
// pre-fix past-seam row scored 567 because it was one of those two halves and
// the other was missing.)

import { describe, it, expect } from 'vitest'
import { decomposeFeatures, compileSingleTile } from './vector-tiler'
import type { GeoJSONFeature } from './geojson-types'

/** z2 columns that receive polygon fill, with their fill-vertex counts, plus
 *  the lon extent of every part `decomposeFeatures` emitted (world copies
 *  included). y=1 is the equatorial row at z2. */
function tiledPolygon(coordinates: number[][][] | number[][][][], multi = false) {
  const feature = {
    type: 'Feature',
    properties: { name: 'seam-crosser' },
    geometry: { type: multi ? 'MultiPolygon' : 'Polygon', coordinates },
  } as unknown as GeoJSONFeature
  const parts = decomposeFeatures([feature])
  const columns: number[] = []
  const counts: number[] = []
  let totalVertices = 0
  for (let x = 0; x < 4; x++) {
    const tile = compileSingleTile(parts, 2, x, 1, 7)
    if (tile && tile.vertices.length > 0) {
      columns.push(x)
      counts.push(tile.vertices.length)
      totalVertices += tile.vertices.length
    }
  }
  return {
    columns,
    counts,
    totalVertices,
    partLonRanges: parts.map((p) => [p.minLon, p.maxLon]),
  }
}

/** A closed CCW box ring spanning [west, east] × [−10, 10], authored exactly
 *  as a GeoJSON producer writes it (first vertex repeated last). */
function box(west: number, east: number, south = -10, north = 10): number[][] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ]
}

describe('#2550 antimeridian Polygon (past-seam and folded authorings)', () => {
  // The oracle: the same 20° box straddling an ordinary z2 tile edge (lon 90).
  const ordinaryEdge = tiledPolygon([box(80, 100)])

  it('(a) instrument check: a box straddling an ordinary tile edge splits into two tiles', () => {
    // If this ever stops holding, every comparison below is comparing against
    // something other than "a box cut by a tile edge".
    expect(ordinaryEdge.columns).toEqual([2, 3])
    expect(ordinaryEdge.counts[0]).toBe(ordinaryEdge.counts[1])
    expect(ordinaryEdge.totalVertices).toBeGreaterThan(0)
  })

  it('(b) FAIL-BEFORE: a box authored past the seam keeps its beyond-180 half', () => {
    // Pre-fix: columns [3] and half the vertices — the 180…190 half was cut off
    // at merc(180) by the per-tile clip and no world copy carried it west.
    const pastSeam = tiledPolygon([box(170, 190)])

    // The part plus its −360 world copy, exactly as pushPartWithWrap emits for
    // a line: the tail lives as data in the WEST tile, which the renderer draws
    // at world-copy +1 → back onto 180…190.
    expect(pastSeam.partLonRanges).toEqual([
      [170, 190],
      [-190, -170],
    ])
    expect(pastSeam.columns).toEqual([0, 3])
    expect(pastSeam.counts).toEqual(ordinaryEdge.counts)
    expect(pastSeam.totalVertices).toBe(ordinaryEdge.totalVertices)
  })

  it('(c) FAIL-BEFORE: the folded authoring tiles exactly like the past-seam one', () => {
    // Pre-fix: [0,1,2,3] with 4319 vertices each — the un-unwrapped 170 → −170
    // edge is 340° wide in authored longitude, so every column it swept got
    // fill. Post-fix the ring is carried onto one branch (170 → 190) and the
    // two authorings are indistinguishable downstream.
    const folded = tiledPolygon([box(170, -170)])
    const pastSeam = tiledPolygon([box(170, 190)])
    expect(folded).toEqual(pastSeam)
  })

  it('(d) a hole authored on the far side of the seam stays inside its shell', () => {
    // Producer shape: rings normalized INDEPENDENTLY into (−180, 180], so the
    // hole's first vertex can sit on the other branch from the shell's. The
    // shell here is past-seam (175…185); the hole is written from its west
    // corner (−178 → 178 → …), which unwraps onto −182…−178 on its own branch —
    // a whole world away from the shell that contains it.
    const shell = box(175, 185, -5, 5)
    const foldedHole = [
      [-178, -2],
      [178, -2],
      [178, 2],
      [-178, 2],
      [-178, -2],
    ]
    const unwrappedHole = box(178, 182, -2, 2)

    const withFoldedHole = tiledPolygon([shell, foldedHole])
    const withUnwrappedHole = tiledPolygon([shell, unwrappedHole])
    expect(withFoldedHole).toEqual(withUnwrappedHole)

    // …and the hole is genuinely subtracted, so the equality above is not two
    // copies of "the hole was dropped". Per TILE, not in total: the two halves
    // of this shell hold 168 + 182 vertices with the hole and 175 + 175 without
    // it, so the totals happen to agree and only the split tells them apart.
    const solid = tiledPolygon([shell])
    expect(withFoldedHole.counts).not.toEqual(solid.counts)
  })

  it('(e) a MultiPolygon whose parts are folded tiles like its unwrapped twin', () => {
    // The shape Natural-Earth-style sources emit for a seam-crossing group:
    // several parts, each folded into (−180, 180] on its own.
    const folded = tiledPolygon([[box(170, -170, -8, -2)], [box(175, -175, 2, 8)]], true)
    const unwrapped = tiledPolygon([[box(170, 190, -8, -2)], [box(175, 185, 2, 8)]], true)
    expect(unwrapped.columns).toEqual([0, 3])
    expect(folded).toEqual(unwrapped)
  })

  it('(f) an exact half- and whole-world edge is NOT read as a fold', () => {
    // The two deltas a fold can never produce: two longitudes normalized into
    // (−180, 180] are strictly less than a whole world apart unless they are
    // −180 and 180 themselves. Rounding either to the nearer branch destroys
    // real geometry — the z=0 world rectangle would collapse to zero width and
    // an eastern-hemisphere box would jump to the west.
    const eastHemisphere = tiledPolygon([box(0, 180)])
    expect(eastHemisphere.columns).toEqual([2, 3])

    const world = tiledPolygon([box(-180, 180)])
    expect(world.columns).toEqual([0, 1, 2, 3])
  })
})
