// Repro for #2550 — the inline tiler gave LineStrings a seam story
// (`pushPartWithWrap`, #1221 round 2 / #2547) and polygons none. Measured end to
// end at z2 through the real entry points (`decomposeFeatures` →
// `compileSingleTile`) on a 20°-wide box at lat −10…10:
//
//   authored 170 … 190  (past the seam)  → fill in z2 x3 ONLY, 567 vertices —
//                                          the 180…190 half existed in no tile
//
// The oracle is the same box straddling an ORDINARY tile edge (80…100 straddles
// the z2 x2|x3 boundary at lon 90). Once the beyond-seam half is emitted as the
// ±360 world copy the renderer draws at world-copy ±1 (ADR-0006), the seam is a
// tile edge like any other — so the past-seam box must tile EXACTLY like that
// control, tile for tile and vertex for vertex.
//
// (The control is NOT the 1519 vertices of a box that fits inside one tile: any
// 20° box straddling a tile edge tessellates to 567 + 567. The pre-fix row
// scored 567 because it was one of those halves and the other was missing.)
//
// The issue ALSO reported a folded ring (170 → −170) filling all four columns
// and called that a second defect. It is not: a ring bounds an area and is read
// at face value, so that ring IS a 340°-wide box. Nothing local distinguishes a
// fold from a wide edge, and the first fix here guessed "fold" — which broke the
// pre-existing z=0 world-parent contract in data/src/sub-tile-generator.test.ts,
// whose parent ring is exactly [−170 … 170]. Arms (c) and (g) pin the literal
// reading; the correction is recorded on the issue.

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

  it('(c) the folded authoring is a DIFFERENT shape, not the past-seam one', () => {
    // `box(170, -170)` is a 340°-wide box read literally, so it is NOT the 20°
    // box `box(170, 190)` describes — the two differ only in which side of the
    // seam the interior is on, and nothing local can tell a fold from a wide
    // edge (see (g)). Asserting the two identical is what broke the pre-existing
    // z=0 world-parent contract in data/src/sub-tile-generator.test.ts.
    const folded = tiledPolygon([box(170, -170)])
    const pastSeam = tiledPolygon([box(170, 190)])
    expect(folded.columns).toEqual([0, 1, 2, 3])
    expect(pastSeam.columns).toEqual([0, 3])
    expect(folded).not.toEqual(pastSeam)
  })

  it('(d) a past-seam hole is subtracted from its past-seam shell, world copy included', () => {
    // The unambiguous authoring: both rings written past the seam, so no fold
    // has to be guessed. The hole must survive the ±360 world copy — the copy
    // shifts every ring of the part by one world, so a hole left behind would
    // show up as a solid tile on the west side.
    const shell = box(175, 185, -5, 5)
    const hole = box(178, 182, -2, 2)

    const holed = tiledPolygon([shell, hole])
    const solid = tiledPolygon([shell])
    expect(holed.columns).toEqual(solid.columns)
    // Genuinely subtracted, on BOTH the original and its world copy — per tile,
    // because the totals can coincide while one side silently lost the hole.
    expect(holed.counts).not.toEqual(solid.counts)
    expect(holed.counts.length).toBe(2)
  })

  it('(e) every part of a past-seam MultiPolygon gets its own world copy', () => {
    // The shape a producer emits for a seam-crossing group once it has split at
    // the antimeridian as RFC 7946 asks: several parts, each authored past 180.
    // pushPartWithWrap runs per part, so each must carry its own −360 copy.
    const unwrapped = tiledPolygon([[box(170, 190, -8, -2)], [box(175, 185, 2, 8)]], true)
    expect(unwrapped.columns).toEqual([0, 3])
    expect(unwrapped.partLonRanges).toEqual([
      [170, 190],
      [-190, -170],
      [175, 185],
      [-185, -175],
    ])
  })

  it('(g) a WIDE ring is read literally — no |dlon| is treated as a fold', () => {
    // The contract this file has to live under, and the one that refutes reading
    // a >180° edge as a fold: a ring is an AREA boundary, taken at face value.
    // `box(-170, 170)` is a 340°-wide box, not a 20° box across the seam — the
    // two are indistinguishable from any single edge, so only the literal
    // reading is decidable. Pinned since long before this issue by
    // data/src/sub-tile-generator.test.ts ("clips z=0 world parent into a z=2
    // child"), whose z=0 parent is exactly this ring and whose mid-world child
    // must receive geometry. RFC 7946 §3.1.9 puts the burden on the producer to
    // split at the antimeridian, which is why a folded ring cannot be inferred.
    const wide = tiledPolygon([box(-170, 170)])
    expect(wide.columns).toEqual([0, 1, 2, 3])
    // …and it is genuinely the wide box, not a sliver: the mid-world columns
    // carry as much fill as the edge ones.
    expect(Math.min(...wide.counts)).toBeGreaterThan(0)
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
