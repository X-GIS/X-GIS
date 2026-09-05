// #2061 — azimuthal_equidistant.forward must not collapse near its centre.
//
// The old form derived the angular distance as c = acos(cos_c) and scaled the
// tangent-plane direction by c / sin c. Once cos_c rounds to 1 the distance is
// gone before any guard runs: 637 m from the centre in f64 (behind the explicit
// `c < 1e-4` return), 1555 m in f32, where the acos floor bites first — the GPU
// twin. The stable form rebuilds sin c from the tangent-plane components
// (xu, yu), which are made of small quantities and keep their relative precision
// at any distance; c = atan2(sin c, cos c) is exact through zero.
//
// This is the f64 witness: a radial ladder from 10° down to 1e-8° (1.1 mm) at
// three centres and eight bearings. Every rung must land at the great-circle
// distance (haversine — itself stable at small angles) to within 1 µm or 1e-9
// relative, strictly grow toward the outer rungs, and carry the true azimuth.
// The 1e-4° rung is the witness #2061 names: it projected to the exact centre
// before the fix.

import { describe, it, expect } from 'vitest'
import { azimuthalEquidistant } from './projection'
import { EARTH } from '@xgis/shared'

const R = EARTH.sphereR
const DEG = Math.PI / 180

/** Great-circle distance in metres — haversine, stable at small angles. */
function greatCircle(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const p1 = lat1 * DEG
  const p2 = lat2 * DEG
  const h =
    Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Initial bearing from (lon1, lat1) to (lon2, lat2), degrees clockwise from north. */
function bearingTo(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const p1 = lat1 * DEG
  const p2 = lat2 * DEG
  const dl = (lon2 - lon1) * DEG
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return (((Math.atan2(y, x) / DEG) % 360) + 360) % 360
}

/** Spherical direct problem: the point `delta` radians along `bearing` (deg) from the centre. */
function destination(clon: number, clat: number, bearing: number, delta: number): [number, number] {
  const p1 = clat * DEG
  const b = bearing * DEG
  const sp2 = Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(b)
  const p2 = Math.asin(sp2)
  const l2 =
    clon * DEG +
    Math.atan2(Math.sin(b) * Math.sin(delta) * Math.cos(p1), Math.cos(delta) - Math.sin(p1) * sp2)
  return [l2 / DEG, p2 / DEG]
}

const angleDiff = (a: number, b: number): number => {
  const d = Math.abs(((a - b) % 360) + 360) % 360
  return Math.min(d, 360 - d)
}

const CENTRES: Array<[number, number]> = [
  [0, 0],
  [127, 37.5],
  [-100, 60],
]
// Outer to inner: 10° (1113 km) down to 1e-8° (1.1 mm).
const LADDER_DEG = [10, 1, 0.1, 0.01, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8]
const BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315]

describe('#2061 azimuthal_equidistant forward — no centre collapse (f64 ladder)', () => {
  for (const [clon, clat] of CENTRES) {
    const proj = azimuthalEquidistant(clon, clat)

    it(`centre (${clon}, ${clat}): every rung lands at R·c, radius strictly grows outward, azimuth is true`, () => {
      for (const bearing of BEARINGS) {
        let outer = Infinity
        for (const stepDeg of LADDER_DEG) {
          const [lon, lat] = destination(clon, clat, bearing, stepDeg * DEG)
          const [x, y] = proj.forward(lon, lat)
          const r = Math.hypot(x, y)
          const truth = greatCircle(clon, clat, lon, lat)
          const where = `bearing ${bearing}°, ${stepDeg}° (${truth.toFixed(6)} m)`
          expect(r, `${where}: radius`).toBeGreaterThan(0)
          expect(r, `${where}: radius must shrink toward the centre`).toBeLessThan(outer)
          expect(Math.abs(r - truth), `${where}: |r − R·c|`).toBeLessThanOrEqual(
            Math.max(1e-6, 1e-9 * truth),
          )
          // The azimuth of (x east, y north). The bearing formula's own cancellation
          // sets the floor below 1e-5°; the rungs above it are checked to 1e-6°.
          if (stepDeg >= 1e-5) {
            const az = (((Math.atan2(x, y) / DEG) % 360) + 360) % 360
            expect(
              angleDiff(az, bearingTo(clon, clat, lon, lat)),
              `${where}: azimuth`,
            ).toBeLessThan(1e-6)
          }
          outer = r
        }
      }
    })
  }

  it('the exact centre projects to exactly (0, 0)', () => {
    for (const [clon, clat] of CENTRES) {
      expect(azimuthalEquidistant(clon, clat).forward(clon, clat)).toEqual([0, 0])
    }
  })

  it('the #2061 witness: 1e-4° east of the centre is 11 m east, not the centre', () => {
    const [x, y] = azimuthalEquidistant(0, 0).forward(1e-4, 0)
    expect(x).toBeCloseTo(R * 1e-4 * DEG, 6)
    expect(Math.abs(y)).toBeLessThan(1e-6)
  })
})
