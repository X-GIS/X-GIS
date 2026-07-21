// Repro for #1221 — a GeoJSON LineString whose longitudes continue past
// 180 renders broken at the antimeridian: a spurious vertical stroke down
// the 180 seam and a missing shifted world-copy continuation (180→195).
// Polygons crossing the same seam render fine.
//
// Witness: [[165,60],[175,66],[185,68],[195,64]] — a monotone-east polyline
// whose last two vertices sit past +180 (i.e. in the next world copy).
//
// This test drives the REAL project→wrap pipeline (convert → wrap, the
// geojson-vt world-copy machinery) AND the real inline line path
// (makeLinePart → subdivideGreatCircle → compileGeoJSONToTiles) to localize
// where the divergence actually lives.
//
// FINDING (see assertions below):
//   - wrap() is CORRECT: it emits both a centre copy (x 0.958→1.042, past
//     the seam) and a shifted west copy (x -0.042→0.042), no seam segment.
//     The bug is NOT in geojsonvt/wrap.ts or geojsonvt/clip.ts.
//   - The divergence is in the inline vector-tiler path: makeLinePart runs
//     subdivideGreatCircle, whose slerpLonLat returns longitude as
//     atan2(y,x) normalized to (-180,180]. For an antimeridian-crossing
//     line that folds every intermediate vertex across ±180 (178.8 → -179.2)
//     while the ORIGINAL vertices 185/195 stay unwrapped — producing ±360°
//     discontinuities that shred the polyline into every longitude tile.

import { describe, it, expect } from 'vitest'
import { convert } from './convert'
import { wrap } from './wrap'
import { DEFAULT_OPTIONS } from './index'
import type { FlatLine, GeoJSONInput, ProjectedFeature } from './types'
import { subdivideGreatCircle } from '../geometry-sphere'
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

// projectX from convert.ts: lon/360 + 0.5. Seam (lon 180) → world-x 1.0.
const projectX = (lon: number) => lon / 360 + 0.5

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
  describe('inline makeLinePart / subdivideGreatCircle', () => {
    it('great-circle subdivision preserves longitude continuity across the antimeridian', () => {
      // makeLinePart(coords) = { coords: subdivideGreatCircle(coords), ... }.
      // For a monotone-east line the subdivided longitudes must stay
      // continuous with the input (…179, 180, 181… 195) so the polyline
      // does not fold across ±180. slerpLonLat returns atan2-normalized
      // longitude, so intermediates wrap to −179 while original vertices
      // stay at 185/195 → ±360° discontinuities.
      const subdivided = subdivideGreatCircle(WITNESS)
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
  // Round 1 made subdivideGreatCircle monotone (165..195, no fold), but the
  // per-tile clip still cuts the part at the world edge merc(180), so the
  // 180→195 tail was clipped off and landed in NO tile. The renderer draws
  // each tile at world-copy offsets of ±360° (ADR-0006): the ONLY way 180→195
  // can render is for the tail to exist as data in the WEST tiles (−180→−165),
  // which the renderer then draws at world-copy +1 → appears at 180→195.
  // pushLinePartWithWrap emits that −360-shifted copy. This asserts the tail
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
