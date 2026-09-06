// Repro for #1221 — a GeoJSON LineString whose longitudes continue past
// 180 renders broken at the antimeridian: a spurious vertical stroke down
// the 180 seam and a missing shifted world-copy continuation (180→195).
// (This header used to add "polygons crossing the same seam render fine" —
// they did not; that is #2550, gated by ../wrap-polygon-antimeridian.test.ts.)
//
// Witness: [[165,60],[175,66],[185,68],[195,64]] — a monotone-east polyline
// whose last two vertices sit past +180 (i.e. in the next world copy).
//
// This test drives the REAL project→wrap pipeline (convert → wrap, the
// geojson-vt world-copy machinery) AND the real inline line path
// (makeLinePart → subdivideLine → compileGeoJSONToTiles) to localize
// where the divergence actually lives.
//
// FINDING (see assertions below):
//   - wrap() is CORRECT: it emits both a centre copy (x 0.958→1.042, past
//     the seam) and a shifted west copy (x -0.042→0.042), no seam segment.
//     The bug is NOT in geojsonvt/wrap.ts or geojsonvt/clip.ts.
//   - The divergence is in the inline vector-tiler path: makeLinePart runs
//     the line densifier, which then interpolated along the great circle and
//     returned longitude as atan2(y,x) normalized to (-180,180]. For an
//     antimeridian-crossing line that folds every intermediate vertex across
//     ±180 (178.8 → -179.2) while the ORIGINAL vertices 185/195 stay
//     unwrapped — producing ±360° discontinuities that shred the polyline
//     into every longitude tile. (#1522 replaced that interpolant with a
//     lerp in the authored lon/lat space, which cannot leave the branch its
//     endpoints define; the assertion below now holds by construction and
//     stays as the gate that says so.)

import { describe, it, expect } from 'vitest'
import { convert } from './convert'
import { wrap } from './wrap'
import { DEFAULT_OPTIONS } from './index'
import type { FlatLine, GeoJSONInput, ProjectedFeature } from './types'
import { subdivideLine } from '../geometry-sphere'
import { decomposeFeatures, compileSingleTile, lonLatToMercF64 } from '../vector-tiler'

const WITNESS: number[][] = [
  [165, 60],
  [175, 66],
  [185, 68],
  [195, 64],
]

const WITNESS_LINE: GeoJSONInput = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: WITNESS },
} as unknown as GeoJSONInput

// (World-x projection reference: convert.ts projectX = lon/360 + 0.5; the
// seam (lon 180) sits at world-x 1.0 — the assertions below encode the
// projected values directly.)

/** Flatten a ProjectedFeature's LineString geometry to [x,y] pairs. */
function pairs(geom: FlatLine): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < geom.length; i += 3) out.push([geom[i], geom[i + 1]])
  return out
}

function lineFeatures(features: ProjectedFeature[]): ProjectedFeature[] {
  return features.filter((f) => f.type === 'LineString')
}

describe('#1221 antimeridian LineString (lon past 180)', () => {
  // ── Level 1: geojson-vt wrap() — proves the world-copy machinery is fine ──
  describe('wrap() world-copy pipeline', () => {
    const projected = convert(WITNESS_LINE, DEFAULT_OPTIONS)
    const wrapped = lineFeatures(wrap(projected, DEFAULT_OPTIONS))

    it('(a) emits no segment lying along the seam (no consecutive pts both at world-x≈1)', () => {
      for (const f of wrapped) {
        const pts = pairs(f.geometry as FlatLine)
        for (let i = 1; i < pts.length; i++) {
          const bothAtSeam = Math.abs(pts[i - 1][0] - 1) < 1e-6 && Math.abs(pts[i][0] - 1) < 1e-6
          const bothAtZero = Math.abs(pts[i - 1][0]) < 1e-6 && Math.abs(pts[i][0]) < 1e-6
          const differingY = Math.abs(pts[i - 1][1] - pts[i][1]) > 1e-6
          expect(bothAtSeam && differingY, 'seam-parallel segment at x≈1').toBe(false)
          expect(bothAtZero && differingY, 'seam-parallel segment at x≈0').toBe(false)
        }
      }
    })

    it('(b) the shifted world-copy continuation exists (a copy covers world-x just past the seam)', () => {
      // The continuation past lon 180 must appear as a copy near world-x 0
      // (the west edge of the map: the +185..+195 tail shifted by -1).
      const hasWestContinuation = wrapped.some((f) => f.minX < 0.05 && f.maxX > -0.05)
      expect(hasWestContinuation, 'expected a shifted copy near world-x 0').toBe(true)
    })

    it('(c) every world copy is a clean monotone-x polyline (no ±1 world jump inside a copy)', () => {
      for (const f of wrapped) {
        const pts = pairs(f.geometry as FlatLine)
        for (let i = 1; i < pts.length; i++) {
          const dx = Math.abs(pts[i][0] - pts[i - 1][0])
          expect(dx, `world-x jump ${pts[i - 1][0]}→${pts[i][0]} inside one copy`).toBeLessThan(0.5)
        }
      }
    })
  })

  // ── Level 2: inline line path — the ACTUAL divergence site (#1221) ──
  describe('inline makeLinePart / subdivideLine', () => {
    it('line densification preserves longitude continuity across the antimeridian', () => {
      // makeLinePart(coords) = { coords: subdivideLine(coords), ... }.
      // For a monotone-east line the subdivided longitudes must stay
      // continuous with the input (…179, 180, 181… 195) so the polyline
      // does not fold across ±180. The great-circle interpolant returned
      // atan2-normalized longitude, so intermediates wrapped to −179 while
      // original vertices stayed at 185/195 → ±360° discontinuities.
      const subdivided = subdivideLine(WITNESS)
      const lons = subdivided.map((c) => c[0])

      const jumps: string[] = []
      for (let i = 1; i < lons.length; i++) {
        if (Math.abs(lons[i] - lons[i - 1]) > 180) {
          jumps.push(`${lons[i - 1].toFixed(1)}→${lons[i].toFixed(1)}`)
        }
      }
      expect(
        jumps,
        `antimeridian wrap discontinuities in subdivided line: ${jumps.join(', ')}`,
      ).toEqual([])

      // And the unwrapped span must match the input span (165→195 = 30°),
      // not blow up to ~374° (−179.2 … 195) once the fold is introduced.
      const span = Math.max(...lons) - Math.min(...lons)
      expect(span, 'subdivided longitude span should stay ≈ input 30°').toBeLessThan(60)
    })
  })

  // ── Level 3: inline TILING must emit the world-copy continuation (#1221 round 2) ──
  //
  // Round 1 made subdivideLine monotone (165..195, no fold), but the
  // per-tile clip still cuts the part at the world edge merc(180), so the
  // 180→195 tail was clipped off and landed in NO tile. The renderer draws
  // each tile at world-copy offsets of ±360° (ADR-0006): the ONLY way 180→195
  // can render is for the tail to exist as data in the WEST tiles (−180→−165),
  // which the renderer then draws at world-copy +1 → appears at 180→195.
  // pushPartWithWrap emits that −360-shifted copy. This asserts the tail
  // reaches BOTH the east tile (z2 x3) AND the wrapped west tile (z2 x0).
  describe('inline compileSingleTile world-copy continuation', () => {
    const parts = decomposeFeatures([WITNESS_LINE as unknown as GeoJSONInput] as never)

    // Decode a packed stride-10 DSFUN line vertex buffer back to absolute lon.
    const merc1 = lonLatToMercF64(1, 0)[0]
    function decodeLons(tile: { lineVertices: Float32Array }, tileWestLon: number): number[] {
      const tileMx = lonLatToMercF64(tileWestLon, 0)[0]
      const lv = tile.lineVertices
      const out: number[] = []
      for (let i = 0; i < lv.length; i += 10) out.push((lv[i] + lv[i + 2] + tileMx) / merc1)
      return out
    }

    // z2 tile west lon: x/4·360 − 180. x3 → 90 (east), x0 → −180 (west).
    const east = compileSingleTile(parts, 2, 3, 1, 7)
    const west = compileSingleTile(parts, 2, 0, 1, 7)

    it('(a) the east tile (z2 x3) carries the pre-seam span 165→180', () => {
      expect(east, 'z2 x3 must compile').not.toBeNull()
      expect(east!.lineVertices.length, 'z2 x3 has line geometry').toBeGreaterThan(0)
      const lons = decodeLons(east!, 90)
      // Every east vertex is in the primary 90..180 half, monotone toward the seam.
      for (const l of lons) expect(l, `east lon ${l} in (90,180]`).toBeGreaterThan(90)
      for (const l of lons) expect(l, `east lon ${l} ≤ 180`).toBeLessThanOrEqual(180.001)
    })

    it('(b) FAIL-BEFORE: the wrapped west tile (z2 x0) carries the −360-shifted tail', () => {
      // Pre-fix this tile is null (the beyond-180 tail was clipped off and never
      // shifted west) — the reviewer's no-west-tile probe. Post-fix it holds the
      // 180→195 tail shifted by −360 into −180→−165, which the renderer draws at
      // world-copy +1 back onto 180→195.
      expect(west, 'z2 x0 must compile (the shifted copy lands here)').not.toBeNull()
      expect(west!.lineVertices.length, 'z2 x0 has line geometry').toBeGreaterThan(0)
      const lons = decodeLons(west!, -180)
      // Every west vertex is the tail shifted by −360: lon ∈ [−180,−165], and
      // lon+360 ∈ (180,195] is a genuine beyond-seam longitude of the input.
      for (const l of lons) {
        expect(l, `west lon ${l} ≥ −180`).toBeGreaterThanOrEqual(-180.001)
        expect(l, `west lon ${l} ≤ −165`).toBeLessThanOrEqual(-164.999)
        expect(l + 360, `west lon+360 ${l + 360} is a beyond-seam lon (>180)`).toBeGreaterThan(180)
      }
    })
  })
})

// ── #2547: the FOLDED authoring of the same seam crossing ──
//
// Everything above drives the past-seam convention (165→195). Most producers
// emit the other one: a LineString folded back into (−180, 180], e.g.
// [[170,0],[-170,0]] for the same 20° span. `subdivideLine` interpolated the
// intermediates on the unwrapped branch (171…189) but pushed the authored
// endpoint −170 verbatim, leaving a 359° step. The part's bbox then spanned
// −170…189, `pushPartWithWrap` copied that, and the per-tile clip handed a
// piece to every z2 column on the equator.
//
// Oracle: the folded input must tile like the same span written unwrapped —
// the representation the #1221 path above already handles.
describe('#2547 folded antimeridian authoring tiles like the unwrapped span', () => {
  /** Drive a producer-shaped Feature through the real entry points and report
   *  both quantities the 359° step corrupted: the lon extent of each emitted
   *  part (including its world-copy), and the z2 columns that receive line
   *  geometry.
   *
   *  Vertex COUNTS are deliberately not compared: the two authorings differ by
   *  one ULP in `greatCircleDistanceDeg` (acos of cos(20°) vs of cos(−340°)),
   *  which lands either side of `Math.ceil` and is not what this gate is about. */
  function tiledSeamCrossing(coords: number[][]): {
    partLonRanges: [number, number][]
    columns: number[]
  } {
    const feature = {
      type: 'Feature',
      properties: { name: 'seam-crosser' },
      geometry: { type: 'LineString', coordinates: coords },
    } as unknown as GeoJSONInput
    const parts = decomposeFeatures([feature] as never)
    const columns: number[] = []
    for (let x = 0; x < 4; x++) {
      const tile = compileSingleTile(parts, 2, x, 1, 7)
      if (tile && tile.lineVertices.length > 0) columns.push(x)
    }
    return { partLonRanges: parts.map((p) => [p.minLon, p.maxLon]), columns }
  }

  it('(a) a two-point folded crossing tiles like its unwrapped twin', () => {
    // Instrument check: the unwrapped control is the documented two-tile
    // world-copy result (x3 carries 170→180, x0 the −360-shifted tail).
    const unwrapped = tiledSeamCrossing([
      [170, 0],
      [190, 0],
    ])
    expect(unwrapped.columns).toEqual([0, 3])
    expect(unwrapped.partLonRanges).toEqual([
      [170, 190],
      [-190, -170],
    ])

    // FAIL-BEFORE: the folded arm's part spanned −170…189 and reached x1
    // (−90…0) and x2 (0…90), nowhere near the feature.
    const folded = tiledSeamCrossing([
      [170, 0],
      [-170, 0],
    ])
    expect(folded).toEqual(unwrapped)
  })

  it('(b) a folded polyline crossing the seam twice tiles like its unwrapped twin', () => {
    // Per vertex, not just the last one: each successive point has to be
    // carried onto the running branch, so the offset accumulates and cancels.
    const folded = tiledSeamCrossing([
      [175, 20],
      [-175, 22],
      [175, 24],
      [-175, 26],
    ])
    const unwrapped = tiledSeamCrossing([
      [175, 20],
      [185, 22],
      [175, 24],
      [185, 26],
    ])
    expect(unwrapped.columns).toEqual([0, 3])
    expect(unwrapped.partLonRanges).toEqual([
      [175, 185],
      [-185, -175],
    ])
    expect(folded).toEqual(unwrapped)
  })

  // ── The ±180 / ±360 exemption inside `unwrapLonBranch` ──
  //
  // `geometry-sphere.ts` rounds a Δlon to the nearest whole-world branch EXCEPT
  // at the two exact boundaries (`mag <= 180 || mag === 360`). Two longitudes
  // normalized into (−180, 180] are strictly less than a whole world apart
  // unless they are −180 and 180 themselves, so neither boundary can be a fold,
  // and rounding either one destroys real geometry.
  //
  // These arms live HERE, on the line path, because that is the only place the
  // exemption still runs: `subdivideLine` is `unwrapLonBranch`'s sole production
  // caller since #2550's per-ring unwrap was reverted (a ring bounds an AREA and
  // is read at face value — RFC 7946 §3.1.9 puts the split burden on the
  // producer, so a wide ring edge is a wide box, not a fold). The arm that used
  // to stand for the exemption — `(f)` in ../wrap-polygon-antimeridian.test.ts —
  // goes through `tiledPolygon`, which no longer reaches this code at all.
  //
  // LINES are the other side of that settled asymmetry: they take the SHORT way
  // round, which is what arm (e) below controls for and what
  // ../parallel-arc-fidelity.test.ts pins at the densifier.
  //
  // End to end through `decomposeFeatures` → `compileSingleTile` rather than
  // against `subdivideLine`'s array, because the quantity the exemption protects
  // is the part's lon extent that the per-tile clip reads — the same observables
  // arms (a)/(b) above use, so one harness covers both.
  describe('#2550 an exact half- or whole-world line edge is NOT read as a fold', () => {
    it('(c) mag === 360: a −180 → 180 line sweeps the whole world, it does not collapse', () => {
      // FAIL-BEFORE (exemption deleted): Δlon = +360 rounds to one whole world,
      // so the second vertex is rewritten to −180. The line becomes a zero-width
      // point — partLonRanges [[-180, -180]], columns [0], and `subdivideLine`
      // returns 2 vertices instead of 65 because the span is now 0.
      const world = tiledSeamCrossing([
        [-180, 0],
        [180, 0],
      ])
      expect(world.partLonRanges, 'the full-world sweep collapsed to a point').toEqual([
        [-180, 180],
      ])
      expect(world.columns, 'a full-world line must reach every z2 column').toEqual([0, 1, 2, 3])
    })

    it('(d) mag === 180: a 0 → 180 line stays in the eastern hemisphere', () => {
      // FAIL-BEFORE (exemption deleted): Δlon = +180 is exactly half a world and
      // `Math.round(0.5)` is 1, so the endpoint is rewritten to −180 and the
      // whole hemisphere edge flips west — partLonRanges [[-180, 0]],
      // columns [0, 1].
      const eastern = tiledSeamCrossing([
        [0, 0],
        [180, 0],
      ])
      expect(eastern.partLonRanges, 'the hemisphere edge flipped onto the other half').toEqual([
        [0, 180],
      ])
      expect(eastern.columns, 'an eastern-hemisphere line must tile x2 and x3').toEqual([2, 3])
    })

    it('(c2) the SAME at Δlon = −360: a 180 → −180 line also sweeps the whole world', () => {
      // (c) alone leaves a live mutant: `mag === 360` -> `rawDLon === 360` keeps
      // (c) green (its delta is +360) while THIS line, whose delta is −360, gets
      // rounded and collapses to a point. The exemption is written on |Δlon|, so
      // it owes an arm on each side of zero.
      const world = tiledSeamCrossing([
        [180, 0],
        [-180, 0],
      ])
      expect(world.partLonRanges, 'the −360 full-world sweep collapsed to a point').toEqual([
        [-180, 180],
      ])
      expect(world.columns, 'a full-world line must reach every z2 column').toEqual([0, 1, 2, 3])
    })

    it('(d2) a Δlon JUST past the half-world boundary is folded, in the negative direction', () => {
      // The exemption draws its line at 180, so the arm that guards that line
      // has to sit just past it. 90 → −110 is a −200 step: the long way west is
      // 200°, the short way east is 160°, and a LINE takes the short way, so the
      // endpoint is carried to 250 and the part gets its −360 world copy.
      //
      // This kills a mutant no other arm here does. Arms (a)/(b)/(e) all fold a
      // 340° step, so `mag <= 180` -> `mag < 270` (or any threshold between 200
      // and 340) leaves every one of them green; measured, that mutant survives
      // all 336 tiler tests without this arm.
      const past = tiledSeamCrossing([
        [90, 0],
        [-110, 0],
      ])
      expect(past.partLonRanges, 'a −200 step stopped being read as a fold').toEqual([
        [90, 250],
        [-270, -110],
      ])
    })

    it('(e) CONTROL: a genuine fold is still unwrapped, so (c) and (d) are not vacuous', () => {
      // The exemption exempts the two boundaries and nothing else. Deleting
      // `unwrapLonBranch` outright would green (c) and (d) — this arm is what
      // says the unwrap is still there: 170 → −170 is a real 20° fold and must
      // come out as 170 → 190 with its −360 world copy, exactly as (a) asserts.
      const folded = tiledSeamCrossing([
        [170, 0],
        [-170, 0],
      ])
      expect(folded.partLonRanges, 'a genuine fold stopped being unwrapped').toEqual([
        [170, 190],
        [-190, -170],
      ])
      expect(folded.columns).toEqual([0, 3])
    })
  })
})
