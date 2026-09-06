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
import {
  dropConsecutiveDuplicates,
  extractNonSyntheticArcs,
  makeSameBoundarySidePredicateMerc,
} from './vector-tiler'
import { lonLatToMercF64, projectRingsToMM } from './ecef-packing'
import { precisionForZoomMM } from './encoding'

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

// ─────────────────────────────────────────────────────────────────────────────
// #2553: a REAL polygon edge that RUNS ALONG a tile side is not synthetic.
//
// The classifier above re-derives "synthetic" GEOMETRICALLY — both endpoints
// within 1 m of the same tile-rect axis. That is exactly what a boundary-
// coincident REAL edge looks like: a box whose west side is on lon 0, or whose
// south side is on the equator (the shape every whole-degree administrative /
// sea-area grid has), lost that side from its OUTLINE while the fill kept it.
// Neither eps direction separates the two — a real edge ON the boundary is at
// distance 0, the same as the closing edge Sutherland-Hodgman inserts.
//
// FIX: carry PROVENANCE. `clipPolygonToRect` records every vertex IT created
// (`intersect`) in the caller's identity Set, and an edge is synthetic only
// when the geometric predicate holds AND BOTH endpoints are clipper-inserted.
// The geometric predicate stays as the fallback for rings that reach the
// classifier without provenance (the runtime sub-tilers).

// z1 tile (x=1, y=0): lon [0°, 180°], lat [0°, 85.05°] — the MM rect is
// west/south at the origin, east/north at the Mercator world edge. Derived the
// way the tiler derives it, so `mxW`/`myS` are the SAME f64 values a ring
// authored on lon 0 / the equator projects to.
const Z1 = 1
const N1 = 1 << Z1
const t1West = (1 / N1) * 360 - 180
const t1East = (2 / N1) * 360 - 180
const t1LatN = (Math.atan(Math.sinh(Math.PI * (1 - 0 / N1))) * 180) / Math.PI
const t1LatS = (Math.atan(Math.sinh(Math.PI * (1 - 2 / N1))) * 180) / Math.PI
const [t1MxW, t1MyS] = lonLatToMercF64(t1West, t1LatS)
const [t1MxE, t1MyN] = lonLatToMercF64(t1East, t1LatN)
const t1SidePred = makeSameBoundarySidePredicateMerc(t1MxW, t1MyS, t1MxE, t1MyN, 1.0)
const P1 = precisionForZoomMM(Z1)

/** A GeoJSON-shaped (closed, CCW) lon/lat box, projected to MM by the same
 *  `projectRingsToMM` the polygon pipeline entry uses — the exact ring shape
 *  `clipPolygonToRect` receives in production. */
function mmBox(lonW: number, latS: number, lonE: number, latN: number): number[][] {
  return projectRingsToMM([
    [
      [lonW, latS],
      [lonE, latS],
      [lonE, latN],
      [lonW, latN],
      [lonW, latS],
    ],
  ])[0]!
}

/** Stroke segments the outline path actually emits for a clipped ring —
 *  mirrors the production call site (extract → drop the S-H closing duplicate
 *  → the whole-ring case strokes its last→first edge too). */
function strokeSegments(clipped: number[][][], inserted?: Set<number[]>): number {
  let n = 0
  for (const ring of clipped) {
    if (ring.length < 2) continue
    for (const arc of extractNonSyntheticArcs(ring, t1SidePred, inserted)) {
      const closed = arc.length >= 3 && arc === ring
      const clean = dropConsecutiveDuplicates(arc)
      if (clean.length < 2) continue
      n += closed ? clean.length : clean.length - 1
    }
  }
  return n
}

/** Clip a ring the way the polygon tiler does, capturing clipper provenance. */
function clipZ1(ring: number[][]): { clipped: number[][][]; inserted: Set<number[]> } {
  const inserted = new Set<number[]>()
  const clipped = clipPolygonToRect([ring], t1MxW, t1MyS, t1MxE, t1MyN, P1, inserted)
  return { clipped, inserted }
}

describe('#2553 a real polygon edge lying along a tile side keeps its stroke', () => {
  it('control: a box 1° clear of the tile rect strokes all 4 sides', () => {
    const { clipped, inserted } = clipZ1(mmBox(1, 1, 20, 20))
    expect(clipped.length).toBe(1)
    expect(inserted.size).toBe(0) // nothing was clipped away
    expect(strokeSegments(clipped, inserted)).toBe(4)
  })

  it('a box whose WEST side is exactly on lon 0 strokes all 4 sides (fail-before: 3)', () => {
    const { clipped, inserted } = clipZ1(mmBox(t1West, 1, 20, 20))
    expect(clipped.length).toBe(1)
    // The clip removed nothing: every vertex is the source ring's own.
    expect(inserted.size).toBe(0)
    expect(strokeSegments(clipped, inserted)).toBe(4)
  })

  it('a box whose SOUTH side is exactly on the equator strokes all 4 sides (fail-before: 3)', () => {
    const { clipped, inserted } = clipZ1(mmBox(1, t1LatS, 20, 20))
    expect(clipped.length).toBe(1)
    expect(inserted.size).toBe(0)
    expect(strokeSegments(clipped, inserted)).toBe(4)
  })

  it('a genuinely clipped box still loses ONLY the inserted closing edge', () => {
    // Straddles the tile's west edge: the clip inserts the two boundary
    // vertices and the run between them is the synthetic closure.
    const { clipped, inserted } = clipZ1(mmBox(-10, 1, 20, 20))
    expect(clipped.length).toBe(1)
    expect(inserted.size).toBe(2)
    expect(strokeSegments(clipped, inserted)).toBe(3)
  })

  it('a ring that is ENTIRELY the tile rect (every vertex clipper-made) strokes nothing', () => {
    // A polygon covering the whole tile and beyond. Authored directly in MM
    // (the ring space the clip receives) because a lon/lat ring cannot reach
    // past this z1 row's north edge — it IS the Mercator world edge.
    const covering: number[][] = [
      [t1MxW - 1e6, t1MyS - 1e6],
      [t1MxE + 1e6, t1MyS - 1e6],
      [t1MxE + 1e6, t1MyN + 1e6],
      [t1MxW - 1e6, t1MyN + 1e6],
      [t1MxW - 1e6, t1MyS - 1e6],
    ]
    const { clipped, inserted } = clipZ1(covering)
    expect(clipped.length).toBe(1)
    expect(clipped[0]!.every((v) => inserted.has(v))).toBe(true)
    expect(strokeSegments(clipped, inserted)).toBe(0)
  })

  it('WITHOUT provenance the geometric predicate still strips the tile-rect ring', () => {
    // Rings reach `extractNonSyntheticArcs` without provenance from the
    // runtime sub-tilers (sub-tile-generator, polygon-mesh), which re-clip a
    // parent tile's STORED rings. That fallback must keep working.
    const { clipped } = clipZ1([
      [t1MxW - 1e6, t1MyS - 1e6],
      [t1MxE + 1e6, t1MyS - 1e6],
      [t1MxE + 1e6, t1MyN + 1e6],
      [t1MxW - 1e6, t1MyN + 1e6],
      [t1MxW - 1e6, t1MyS - 1e6],
    ])
    expect(strokeSegments(clipped)).toBe(0)
  })

  it('a box that only TOUCHES the tile from outside strokes nothing (fail-before: 1)', () => {
    // The MIXED-provenance case the three arms above do not reach: they all
    // clip to `inserted.size === 0` (wholly inside) or to a ring whose whole
    // boundary run is clipper-made. Here one boundary-coincident edge has ONE
    // clip-made endpoint and ONE source endpoint, which is the shape a real
    // coastline produces when it runs along a tile side and the clipper
    // truncates it. The box spans lon [-20, 0] x lat [1, 21]: entirely WEST of
    // this tile, with its east side exactly on the tile's west edge, so it has
    // zero area here and must contribute no stroke.
    //
    // Pre-guard this stroked 1 segment: `rescuesEdge` correctly reports the two
    // SOURCE vertices as real (they are the box's own corners), so the
    // collinear run was not synthetic and a line was drawn down the tile
    // border for a feature with no area in the tile. The old purely geometric
    // predicate returned 0 here, so the provenance narrowing regressed it —
    // which is why the guard is on AREA, not on provenance.
    const { clipped, inserted } = clipZ1(mmBox(t1West - 20, 1, t1West, 20))
    expect(clipped.length).toBe(1)
    // The fixture really is MIXED — if this ever becomes all-source or
    // all-clipper the arm below stops testing what it says it tests.
    const ring = clipped[0]!
    const made = ring.filter((v) => inserted.has(v)).length
    expect(made).toBeGreaterThan(0)
    expect(made).toBeLessThan(ring.length)
    expect(strokeSegments(clipped, inserted)).toBe(0)
  })

  it('the same touch from the SOUTH also strokes nothing (fail-before: 1)', () => {
    // Same defect on the perpendicular axis, so the guard cannot be satisfied
    // by an axis-specific special case.
    const { clipped, inserted } = clipZ1(mmBox(1, t1LatS - 20, 20, t1LatS))
    expect(strokeSegments(clipped, inserted)).toBe(0)
  })

  it('non-vacuous: a box with real area here still strokes, touching side included', () => {
    // The control the two arms above need: the guard must not silence a
    // polygon that genuinely covers part of this tile. Same west-side-on-lon-0
    // placement as the #2553 arm, so a guard keyed on "any vertex on the rect"
    // instead of on AREA would red here.
    const { clipped, inserted } = clipZ1(mmBox(t1West, 1, 20, 20))
    expect(strokeSegments(clipped, inserted)).toBe(4)
  })
})
