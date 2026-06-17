// Regression: polygon OUTLINE stroke along a tile-boundary meridian (#360
// "ocean_land" land outline). A LIGHTER-green vertical line was drawn along
// z3 tile-boundary meridians (e.g. lon=45) over LAND — the land STROKE was
// emitted along a synthetic tile-rect edge that `extractNonSyntheticArcs`
// (#347) is supposed to strip.
//
// ROOT CAUSE (proven by bisecting the real ne_110m_land pipeline):
//   `clipPolygonToRect`'s `intersect()` snaps the PERPENDICULAR coordinate of
//   each boundary crossing to a coarse grid (precisionForZoomMM ⇒ a 10 m grid
//   at z≤5, 100 m at z≤2) so adjacent tiles share boundary vertices. A true
//   intersection's perpendicular coordinate is a convex combination of the
//   segment endpoints (t∈[0,1]); `snapToGrid` can round it OUT of that span by
//   up to half the grid. When the crossing sits near a tile-rect CORNER, that
//   overshoot pushes the point PAST the adjacent (perpendicular) rect edge —
//   e.g. a SOUTH-edge crossing whose snapped x lands a few metres EAST of the
//   east edge. The resulting near-corner vertex is then no longer within
//   `extractNonSyntheticArcs`'s 1 m eps of the east edge, so the synthetic
//   closing edge along that edge ESCAPES the synthetic filter and renders as a
//   spurious near-vertical stroke hugging the tile boundary.
//
// FIX: clamp the snapped perpendicular coordinate to the segment's own
//   [min, max] perpendicular span so the snap can never move the intersection
//   outside the geometrically-valid interval — keeping near-corner crossings ON
//   the rect. Adjacent tiles share the segment, so the clamp is identical on
//   both sides ⇒ seam consistency is preserved.
//
// These tests reconstruct the exact failing primitive in Mercator metres at the
// production precision (no GPU, no geojson-vt fixture): a polygon that crosses
// the EAST edge high and exits through the SOUTH edge with its corner-crossing
// x landing 0.04 m inside the east edge, where the 10 m snap grid would round
// it 2.91 m EAST of the boundary on the pre-fix code.

import { describe, it, expect } from 'vitest'
import { clipPolygonToRect } from './clip'
import { extractNonSyntheticArcs, makeSameBoundarySidePredicateMerc } from './vector-tiler'
import { lonLatToMercF64 } from './ecef-packing'

// z3 tile (x=4, y=4): lon [0°, 45°], a band south of the equator. The east
// edge (lon=45°) projects to a Mercator x that is NOT a multiple of the 10 m
// snap grid, which is what lets a near-corner south crossing snap past it.
const Z = 3
const N = 1 << Z
const TX = 4
const TY = 4
const west = (TX / N) * 360 - 180
const east = ((TX + 1) / N) * 360 - 180
const latN = (Math.atan(Math.sinh(Math.PI * (1 - (2 * TY) / N))) * 180) / Math.PI
const latS = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (TY + 1)) / N))) * 180) / Math.PI
const [mxW, myS] = lonLatToMercF64(west, latS)
const [mxE, myN] = lonLatToMercF64(east, latN)

// precisionForZoomMM(z3) = 0.1 ⇒ snapToGrid rounds to a 10 m grid. Hard-coded
// here to pin the exact production grain the tiler passes at z3.
const PRECISION_MM = 0.1

// A vertex placed 0.04 m inside the east edge: snapToGrid(mxE - 0.04, 0.1)
// rounds to mxE + 2.914 m on the pre-fix code (the overshoot).
const xCross = mxE - 0.04

// Polygon: outside-east at the top (so the east-clip synthesises a vertex
// exactly on the east edge), diving inside-east then below the south edge so
// the corner crossing lands at x = xCross. CCW outer ring.
const failingRing: number[][] = [
  [mxW + 1000, myN - 1000], // NW (inside)
  [mxE + 30000, myN - 1000], // NE outside-east, top  → east-clip ⇒ (mxE, top)
  [mxE + 30000, myS + (myN - myS) * 0.5], // outside-east, mid → east run continues
  [xCross, myS - 1000], // dive inside-east then below south: crosses E and S
  [mxW + 1000, myS - 1000], // SW (outside-south)
  [mxW + 1000, myN - 1000],
]

const sidePred = makeSameBoundarySidePredicateMerc(mxW, myS, mxE, myN, 1.0)

/** Max distance any clipped vertex escapes outside the clip rect (0 = fully
 *  inside). A true clip output must stay within the rect; the pre-fix snap let
 *  near-corner crossings overshoot. */
function maxRectOvershoot(clipped: number[][][]): number {
  let m = 0
  for (const ring of clipped) {
    for (const p of ring) {
      const o = Math.max(0, p[0]! - mxE, mxW - p[0]!, p[1]! - myN, myS - p[1]!)
      if (o > m) m = o
    }
  }
  return m
}

/** Count outline edges that hug a vertical tile boundary: BOTH endpoints
 *  within `eps` metres of the SAME vertical rect edge AND the edge spans a
 *  large vertical extent (a full-tile stroke, not a short coastline stub). */
function nearBoundaryVerticalStrokes(clipped: number[][][], eps: number): number {
  let count = 0
  for (const ring of clipped) {
    for (const arc of extractNonSyntheticArcs(ring, sidePred)) {
      for (let i = 0; i < arc.length - 1; i++) {
        const a = arc[i]!
        const b = arc[i + 1]!
        const bothNearEast = Math.abs(a[0]! - mxE) < eps && Math.abs(b[0]! - mxE) < eps
        const bothNearWest = Math.abs(a[0]! - mxW) < eps && Math.abs(b[0]! - mxW) < eps
        const vertical = Math.abs(a[1]! - b[1]!) > 1000
        if ((bothNearEast || bothNearWest) && vertical) count++
      }
    }
  }
  return count
}

describe('#360 polygon outline boundary-stroke — clip snap overshoot', () => {
  it('east edge x is not on the snap grid (precondition for the overshoot)', () => {
    // If mxE were a 10 m-grid multiple the corner could never snap PAST it;
    // the bug needs a non-grid edge value. Pin it so the test stays meaningful.
    const grid = 1 / PRECISION_MM // 10 m
    expect(Math.abs(mxE % grid)).toBeGreaterThan(0.5)
  })

  it('clipped output never escapes the tile rect (fail-before: 2.9 m east overshoot)', () => {
    const clipped = clipPolygonToRect([failingRing], mxW, myS, mxE, myN, PRECISION_MM)
    expect(clipped.length).toBeGreaterThan(0)
    // Pre-fix this was ~2.914 m (a south crossing snapped east of the east
    // edge). The clamp keeps every vertex on/inside the rect.
    expect(maxRectOvershoot(clipped)).toBeLessThanOrEqual(1e-6)
  })

  it('outline strokes NO near-vertical edge along the tile boundary (fail-before: 1)', () => {
    const clipped = clipPolygonToRect([failingRing], mxW, myS, mxE, myN, PRECISION_MM)
    // The snapped corner is back on the east edge, so the closing run along the
    // east edge is recognised as synthetic and stripped — no spurious stroke.
    expect(nearBoundaryVerticalStrokes(clipped, 5)).toBe(0)
  })

  it('non-vacuous: a REAL coastline edge meeting the boundary IS still stroked', () => {
    // A polygon whose west side is a genuine slanted coastline crossing into the
    // tile must still emit that coastline as stroke — the fix must not strip
    // real interior/boundary-crossing edges, only synthetic axis-aligned ones.
    const coastRing: number[][] = [
      [mxW - 30000, myN - 1000], // outside-west, top → W-clip ⇒ (mxW, top)
      [mxW + (mxE - mxW) * 0.7, myN - 1000], // inside, top
      [mxW + (mxE - mxW) * 0.5, myS + (myN - myS) * 0.5], // interior coastline node
      [mxW + (mxE - mxW) * 0.7, myS + 1000], // inside, bottom
      [mxW - 30000, myS + 1000], // outside-west, bottom → W-clip ⇒ (mxW, bottom)
      [mxW - 30000, myN - 1000],
    ]
    const clipped = clipPolygonToRect([coastRing], mxW, myS, mxE, myN, PRECISION_MM)
    expect(clipped.length).toBeGreaterThan(0)
    let interiorEdges = 0
    for (const ring of clipped) {
      for (const arc of extractNonSyntheticArcs(ring, sidePred)) {
        // arcs are the non-synthetic (real) coastline runs — count their edges
        interiorEdges += Math.max(0, arc.length - 1)
      }
    }
    expect(interiorEdges).toBeGreaterThan(0)
    // And those real edges are NOT all hugging a boundary (the coastline node
    // is deep in the tile interior).
    expect(nearBoundaryVerticalStrokes(clipped, 5)).toBe(0)
  })
})
