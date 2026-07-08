// ═══ Natural-Earth world-copy seam gate (projType 2) — issue #801 ═══
//
// On natural_earth project_geom offset each visible world copy / lobe-step from
// the primary world by a CONSTANT k·2π·EARTH_R (the full Mercator world width).
// But natural_earth's projected period is LATITUDE-VARYING:
//   x(lon,lat) = radians(lon)·x_scale(lat)·R,  x_scale(lat)=0.8707−0.131979·lat²+…
// so 360° of longitude at latitude φ spans 2π·x_scale(φ)·R, not 2π·R. Copies /
// seam-straddling lobes therefore land 2π·R·(1−x_scale(φ)) off — a ~5.18 Mm gap
// at the equator, widening poleward — so the antimeridian seam tears at low zoom.
//
// This gate tests the REAL project_geom_cpu lowering (projectGeomWgsl) — its
// seam-straddling k lobe-step must ride the lat-varying period, not a constant
// 2πR. (The wedge gate probes only lat=0 + the primary-copy oval, so it does not
// catch this.) The GPU world-copy `wo` offset is the same scale factor, modelled
// below. Pure f64, no GPU (SwiftShader / CI lane).

import { describe, expect, it } from 'vitest'
import { projNaturalEarthDWgsl, projectGeomWgsl, wrapLonDelta } from '@xgis/map'

const EARTH_R = 6378137
const NE = 2 // projType natural_earth
const MERC_PERIOD = 2 * Math.PI * EARTH_R // the (wrong, constant) Mercator width

const SEAM_KEEP_EPS = 1e-4
const unwrapKeep = (value: number, refV: number, keepSign: number): number =>
  value - Math.floor((value - refV + 180 - keepSign * SEAM_KEEP_EPS) / 360) * 360

// project_geom_cpu's OWN recentred delta (no world-copy shift), mirroring
// projections.ts project_geom_cpu exactly. projectGeomWgsl uses this.
function cpuDelta(lon: number, clon: number, refLon: number): number {
  const refD = wrapLonDelta(refLon - clon)
  return unwrapKeep(lon - refLon, 0, Math.sign(lon)) + refD
}
// natural_earth's period at latitude φ = 2·proj_natural_earth_d(180,φ).x.
const nePeriod = (lat: number): number => 2 * projNaturalEarthDWgsl(180, lat)[0]

describe('natural_earth world-copy seam — lat-varying period (issue #801)', () => {
  it('REAL project_geom_cpu: the seam-straddling k lobe-step rides 2·π·x_scale(lat)·R, not 2πR', () => {
    // Camera on the antimeridian (clon=±179) makes the world-copy-referenced
    // columns fold (|d|>180, k≠0). Those folded vertices must offset by the
    // natural_earth period. FAILS on baseline (constant k·2πR); the gap the fix
    // closes is (period_merc − period_NE)·|k| ≈ 5.18 Mm per step at the equator.
    let checked = 0
    for (const clon of [179, -179]) {
      for (const refLon of [-720, -360, 0, 360, 720]) {
        for (const lon of [-170, -120, -60, 0, 60, 120, 170]) {
          for (const lat of [0, 40, 75]) {
            const d = cpuDelta(lon, clon, refLon)
            const dw = wrapLonDelta(d)
            const k = Math.round((d - dw) / 360)
            if (k === 0) continue // only the seam-straddling lobes changed
            const real = projectGeomWgsl(NE, lon, lat, clon, 0, refLon)[0]
            const expected = projNaturalEarthDWgsl(dw, lat)[0] + k * nePeriod(lat)
            expect(
              real,
              `clon=${clon} refLon=${refLon} lon=${lon} lat=${lat} k=${k}`,
            ).toBeCloseTo(expected, -1)
            // And the corrected step must actually differ from the Mercator one it
            // replaced (else the test would pass vacuously on the buggy constant).
            expect(Math.abs(k * nePeriod(lat) - k * MERC_PERIOD)).toBeGreaterThan(1e6)
            checked++
          }
        }
      }
    }
    expect(checked, 'no seam-straddling (k≠0) vertices exercised').toBeGreaterThan(0)
  })

  it('the natural_earth period is lat-varying and always narrower than the Mercator width', () => {
    for (const lat of [0, 15, 30, 45, 60, 75, 85]) {
      expect(nePeriod(lat), `lat=${lat}`).toBeLessThan(MERC_PERIOD)
    }
    // strictly decreasing with |lat| (x_scale shrinks poleward)
    expect(nePeriod(60)).toBeLessThan(nePeriod(0))
  })
})
