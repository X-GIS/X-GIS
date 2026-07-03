// ═══ Natural-Earth antimeridian black-wedge gate (projType 2) ═══
//
// User visual QA (OFM Bright, zoom 0.5, lon 180, lat 0): the natural_earth
// oval rendered the blue OCEAN full but the camera-facing wedge of LAND +
// background went BLACK (clearValue — neither land fill nor cream bg band
// covered it).
//
// ROOT (project_geom, projections.ts pseudocylindrical arm): the recentred
// longitude delta `d` is fed RAW into `proj_natural_earth_d`. When the camera
// sits near the antimeridian (clon≈180) the synthetic z=0 bg band's world-copy
// children reference the root, so HALF the 128-column full-world mesh gets
// |d| > 180 (d = −360 … −180). `proj_natural_earth_d` is a 6th-order polynomial
// valid ONLY for d ∈ [−180,180]; at d = −360 it returns a double-width
// wrong-region x that the world offset `wo·2πR` does NOT cancel (NE x(d) is
// NONLINEAR) → the mesh folds and leaves a ~5.2 Mm hole in the camera-facing
// oval (the black wedge). Equirect is clean through the same code because its
// x(d) is LINEAR (the out-of-range d is exactly absorbed by the offset).
//
// FIX (project_geom NE sub-arm + project_geom_cpu mirror): fold `d` into one
// lobe (`dw = wrap_lon_delta(d)`, |dw| ≤ 180) BEFORE the polynomial and push
// the 360°-steps (k) into the lobe offset. No-op for equirect / in-range d.
//
// Two complementary checks, both pure f64 (SwiftShader / no-GPU CI lane):
//   • PRODUCTION pin — projectGeomWgsl (the project_geom_cpu lowering) must
//     equal the corrected in-lobe form. FAILS on baseline (out-of-lobe d).
//   • COVERAGE — an inline faithful mirror of the GPU project_geom (with the
//     world offset) tiles the camera-facing oval with no hole. FAILS on
//     baseline (the ~5.2 Mm black-wedge gap).

import { describe, expect, it } from 'vitest'
import {
  projEquirectangularDWgsl,
  projNaturalEarthDWgsl,
  projectGeomWgsl,
  wrapLonDelta,
} from '@xgis/map'

const DEG2RAD = Math.PI / 180
const EARTH_R = 6378137
const WORLD_M = 2 * Math.PI * EARTH_R // one world width in projected metres
const NE = 2 // projType natural_earth
const EQ = 1 // projType equirectangular
// Visible-oval half-width at the equator (the camera-facing extent at z0.5):
// 180° · DEG2RAD · max-xScale · R, with xScale(lat=0) = 0.8707 the maximum.
const OVAL_HALF = 180 * DEG2RAD * 0.8707 * EARTH_R // ≈ 17.447 Mm
// One bg-band mesh cell at the equator (360/128°): the coverage floor — no gap
// in the visible oval may exceed ~one cell, or a black wedge shows through.
const MESH_CELL = (360 / 128) * DEG2RAD * 0.8707 * EARTH_R

// The synthetic z=0 bg band: a single 128-column mesh spanning lon[−180,180],
// drawn once per world copy (−2..+2). Each copy's tile-centre reference is
// wc·360 (z=0 root tile centre = 0, shifted by the world copy).
const BG_COLUMNS = Array.from({ length: 129 }, (_, i) => -180 + (360 * i) / 128)
const WORLD_COPIES = [-2, -1, 0, 1, 2]

const SEAM_KEEP_EPS = 1e-4
const unwrapKeep = (value: number, refV: number, keepSign: number): number =>
  value - Math.floor((value - refV + 180 - keepSign * SEAM_KEEP_EPS) / 360) * 360

// ── project_geom_cpu's OWN recentred delta (raw ref_lon, no world-copy shift —
//    mirrors projections.ts project_geom_cpu exactly). projectGeomWgsl uses this.
function cpuDelta(lon: number, clon: number, refLon: number): number {
  const refD = wrapLonDelta(refLon - clon)
  return unwrapKeep(lon - refLon, 0, Math.sign(lon)) + refD
}

// ── The GPU project_geom (with the world-copy `wo` shift) — a faithful inline
//    mirror of the projections.ts shader arm, used to model the rasterised
//    bg-band coverage. `fold` toggles the FIX (lobe wrap) vs the BASELINE.
function gpuProjectGeomX(
  lon: number,
  clon: number,
  refLon: number,
  isNE: boolean,
  fold: boolean,
): number {
  const wo = Math.floor((refLon - clon + 180) / 360)
  const lonPrimary = lon - wo * 360
  const refPrimary = refLon - wo * 360
  const refD = wrapLonDelta(refPrimary - clon)
  const d = unwrapKeep(lonPrimary - refPrimary, 0, Math.sign(lonPrimary)) + refD
  if (!isNE) return projEquirectangularDWgsl(d, 0)[0] + wo * WORLD_M
  if (!fold) return projNaturalEarthDWgsl(d, 0)[0] + wo * WORLD_M // pre-fix
  const dw = wrapLonDelta(d)
  const k = Math.round((d - dw) / 360)
  return projNaturalEarthDWgsl(dw, 0)[0] + (wo + k) * WORLD_M
}

function bgBandXs(clon: number, isNE: boolean, fold: boolean): number[] {
  const xs: number[] = []
  for (const wc of WORLD_COPIES) {
    for (const lon of BG_COLUMNS) xs.push(gpuProjectGeomX(lon, clon, wc * 360, isNE, fold))
  }
  return xs
}

function maxGapInOval(xs: number[]): { gap: number; lo: number; hi: number } {
  const inView = xs.filter((x) => Math.abs(x) <= OVAL_HALF).sort((a, b) => a - b)
  let gap = 0
  for (let i = 1; i < inView.length; i++) gap = Math.max(gap, inView[i]! - inView[i - 1]!)
  return { gap, lo: inView[0]!, hi: inView[inView.length - 1]! }
}

describe('natural_earth antimeridian black-wedge — project_geom lobe wrap (projType 2)', () => {
  it('PRODUCTION: projectGeomWgsl(NE) folds every delta into one lobe (|dw| ≤ 180)', () => {
    // The production project_geom_cpu lowering must equal the corrected in-lobe
    // form: proj_natural_earth_d(wrap_lon_delta(d)) + k·2πR. The pre-fix code
    // returned proj_natural_earth_d(d) with |d| up to 360 — the out-of-lobe
    // polynomial that black-wedged the bg band. This pin FAILS on baseline.
    for (const clon of [180, 179, -179, 90, -90]) {
      for (const refLon of WORLD_COPIES.map((wc) => wc * 360)) {
        for (const lon of BG_COLUMNS) {
          const d = cpuDelta(lon, clon, refLon)
          const dw = wrapLonDelta(d)
          const k = Math.round((d - dw) / 360)
          const expected = projNaturalEarthDWgsl(dw, 0)[0] + k * WORLD_M
          expect(
            projectGeomWgsl(NE, lon, 0, clon, 0, refLon)[0],
            `clon=${clon} refLon=${refLon} lon=${lon}: out-of-lobe d=${d} not folded`,
          ).toBe(expected)
        }
      }
    }
  })

  it('COVERAGE: the camera-facing visible oval is fully tiled at the antimeridian (no gap > one cell)', () => {
    // BASELINE: the NE nonlinearity leaves a ~5.2 Mm hole (the black wedge) in
    // the camera-facing oval. FIX: the lobe wrap closes it to ≤ one mesh cell
    // and tiles the full oval edge-to-edge. (clon = ±179 — at exactly ±180 the
    // five world copies coincide on the seam, a measure-zero degeneracy.)
    for (const clon of [179, -179]) {
      const fixed = maxGapInOval(bgBandXs(clon, true, true))
      const baseline = maxGapInOval(bgBandXs(clon, true, false))
      // The fix tiles both halves of the oval with no hole …
      expect(fixed.lo, `clon=${clon}: oval left edge`).toBeLessThan(-OVAL_HALF * 0.9)
      expect(fixed.hi, `clon=${clon}: oval right edge`).toBeGreaterThan(OVAL_HALF * 0.9)
      expect(fixed.gap, `clon=${clon}: black-wedge gap (fixed)`).toBeLessThan(MESH_CELL * 1.5)
      // … while the baseline leaves the ~5.2 Mm wedge (the gate's negative).
      expect(baseline.gap, `clon=${clon}: baseline must reproduce the wedge`).toBeGreaterThan(
        MESH_CELL * 4,
      )
    }
  })

  it('REGRESSION: clon=0 interior vertices are bit-identical to the pre-fix path', () => {
    // At clon = 0 every interior bg-band vertex has |d| ≤ 180, so the lobe wrap
    // is a no-op (dw = d, k = 0). projectGeomWgsl must reproduce the plain
    // polynomial EXACTLY — proving the change is NE-seam-only.
    for (const refLon of WORLD_COPIES.map((wc) => wc * 360)) {
      for (const lon of BG_COLUMNS) {
        const d = cpuDelta(lon, 0, refLon)
        if (Math.abs(d) > 180) continue // out-of-lobe vertices legitimately change
        expect(projectGeomWgsl(NE, lon, 0, 0, 0, refLon)[0]).toBe(projNaturalEarthDWgsl(d, 0)[0])
      }
    }
  })

  it('REGRESSION: equirectangular (projType 1) is UNCHANGED at every vertex/camera', () => {
    // The fix is NE-only — equirect is linear and keeps the shared d path, so
    // projectGeomWgsl(EQ) must still be the bare proj_equirectangular_d(d) (the
    // CPU twin omits the world offset) at every camera, including the
    // antimeridian where the NE arm now folds.
    for (const clon of [0, 90, 180, 179, -179]) {
      for (const refLon of WORLD_COPIES.map((wc) => wc * 360)) {
        for (const lon of BG_COLUMNS) {
          const d = cpuDelta(lon, clon, refLon)
          expect(projectGeomWgsl(EQ, lon, 0, clon, 0, refLon)[0]).toBe(
            projEquirectangularDWgsl(d, 0)[0],
          )
        }
      }
    }
  })
})
