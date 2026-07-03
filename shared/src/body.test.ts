// Byte-identical-Earth guard for the Body authority (issue #798 Phase 1).
//
// P1 centralises the scattered CPU Earth constants onto the shared Body, with
// the DEFAULT active body === EARTH. This suite is the byte-equal ratchet: it
// proves (a) EARTH's derived constants reproduce the EXACT doubles the retired
// `ecef.ts` A/F/E2 constants held, and (b) every ecef geodesy function called
// with the DEFAULT body produces bit-identical output to calling it with an
// explicit EARTH and to the raw pre-refactor formula, over a lon/lat/height
// grid. A real e2/worldMerc regression is a coherent sub-metre shift — this
// catches it on the CPU, ahead of the maintainer's real-GPU DC=0 gate.

import { describe, expect, it } from 'vitest'
import { EARTH, MOON, MARS_IAU2000, makeBody, activeBody } from './body'
import {
  lonLatToECEF,
  ecefToLonLat,
  mercatorToECEF,
  mercatorToECEFSphere,
  lonLatToECEFSphere,
} from './ecef'

// The exact WGS84 inputs the retired ecef.ts module constants used.
const RETIRED_A = 6378137
const RETIRED_F = 1 / 298.257223563
const RETIRED_E2 = RETIRED_F * (2 - RETIRED_F)

describe('EARTH constants are bit-identical to the retired ecef.ts literals', () => {
  it('e2 === 0.0066943799901413165 (= f·(2 − f), the retired E2 expression)', () => {
    expect(EARTH.e2).toBe(0.0066943799901413165)
    expect(EARTH.e2).toBe(RETIRED_E2)
  })
  it('b === 6356752.314245179 (= a·(1 − f))', () => {
    expect(EARTH.b).toBe(6356752.314245179)
    expect(EARTH.b).toBe(RETIRED_A * (1 - RETIRED_F))
  })
  it('worldMerc === pinned literal 40075016.686 (NOT the derived 2·π·a)', () => {
    expect(EARTH.worldMerc).toBe(40075016.686)
    expect(EARTH.worldMerc).not.toBe(2 * Math.PI * RETIRED_A)
  })
  it('a / sphereR / f are the WGS84 inputs (sphereR === a for Earth)', () => {
    expect(EARTH.a).toBe(RETIRED_A)
    expect(EARTH.sphereR).toBe(RETIRED_A)
    expect(EARTH.f).toBe(RETIRED_F)
  })
  it('an unconfigured process defaults to EARTH', () => {
    expect(activeBody()).toBe(EARTH)
  })
})

// Reference formula — the exact math the retired ecef.ts held, recomputed with
// LOCAL constants so the assertion is independent of the module under test.
function refLonLatToECEF(lon: number, lat: number, h: number): [number, number, number] {
  const DEG2RAD = Math.PI / 180
  const lonRad = lon * DEG2RAD
  const latRad = lat * DEG2RAD
  const sinLat = Math.sin(latRad)
  const cosLat = Math.cos(latRad)
  const N = RETIRED_A / Math.sqrt(1 - RETIRED_E2 * sinLat * sinLat)
  return [
    (N + h) * cosLat * Math.cos(lonRad),
    (N + h) * cosLat * Math.sin(lonRad),
    (N * (1 - RETIRED_E2) + h) * sinLat,
  ]
}

const LONS = [-180, -179.999, -90, -45, 0, 45, 90, 120.5, 179.999]
const LATS = [-85, -45, -10, 0, 10, 45, 85]
const HEIGHTS = [0, 100, -50, 5000]
const MERC_HALF = Math.PI * RETIRED_A

describe('default-body geodesy is byte-identical to explicit EARTH and the retired formula', () => {
  it('lonLatToECEF: default === EARTH === reference formula, bit-for-bit', () => {
    for (const lon of LONS)
      for (const lat of LATS)
        for (const h of HEIGHTS) {
          const def = lonLatToECEF(lon, lat, h)
          const exp = lonLatToECEF(lon, lat, h, EARTH)
          const ref = refLonLatToECEF(lon, lat, h)
          for (let k = 0; k < 3; k++) {
            expect(Object.is(def[k], exp[k])).toBe(true)
            expect(Object.is(def[k], ref[k])).toBe(true)
          }
        }
  })

  it('ecefToLonLat: default === EARTH, bit-for-bit (over round-tripped inputs)', () => {
    for (const lon of LONS)
      for (const lat of LATS)
        for (const h of HEIGHTS) {
          const [x, y, z] = lonLatToECEF(lon, lat, h)
          const def = ecefToLonLat(x, y, z)
          const exp = ecefToLonLat(x, y, z, EARTH)
          for (let k = 0; k < 3; k++) expect(Object.is(def[k], exp[k])).toBe(true)
        }
  })

  it('mercator + sphere variants: default === EARTH, bit-for-bit', () => {
    const MS = [-MERC_HALF, -1e6, 0, 1e6, MERC_HALF]
    for (const mx of MS)
      for (const my of MS)
        for (const h of HEIGHTS) {
          const a = mercatorToECEF(mx, my, h)
          const b = mercatorToECEF(mx, my, h, EARTH)
          const c = mercatorToECEFSphere(mx, my, h)
          const d = mercatorToECEFSphere(mx, my, h, EARTH)
          for (let k = 0; k < 3; k++) {
            expect(Object.is(a[k], b[k])).toBe(true)
            expect(Object.is(c[k], d[k])).toBe(true)
          }
        }
    for (const lon of LONS)
      for (const lat of LATS)
        for (const h of HEIGHTS) {
          const s1 = lonLatToECEFSphere(lon, lat, h)
          const s2 = lonLatToECEFSphere(lon, lat, h, EARTH)
          for (let k = 0; k < 3; k++) expect(Object.is(s1[k], s2[k])).toBe(true)
        }
  })
})

describe('non-Earth bodies derive correctly (Moon sphere, Mars ellipsoid)', () => {
  it('MOON is a perfect sphere: f=0, e2=0, b=a=sphereR, worldMerc=2·π·a', () => {
    expect(MOON.f).toBe(0)
    expect(MOON.e2).toBe(0)
    expect(MOON.a).toBe(1737400)
    expect(MOON.b).toBe(1737400)
    expect(MOON.sphereR).toBe(1737400)
    expect(MOON.worldMerc).toBe(2 * Math.PI * 1737400)
  })

  it('Moon ECEF surface radius ≈ 0.2725× Earth (1737400 / 6378137)', () => {
    // On the equator the ECEF magnitude equals the radius; the P2 scale check,
    // verified here at the CPU packing seam with an explicit body argument.
    const [ex] = lonLatToECEF(0, 0, 0, EARTH)
    const [mx] = lonLatToECEF(0, 0, 0, MOON)
    expect(mx / ex).toBeCloseTo(1737400 / 6378137, 12)
  })

  it('MARS_IAU2000 polar/equatorial ratio == 1 − 1/169.8 (oblateness visible)', () => {
    expect(MARS_IAU2000.b / MARS_IAU2000.a).toBeCloseTo(1 - 1 / 169.8, 12)
    // makeBody derives worldMerc as 2·π·sphereR when not overridden.
    expect(makeBody('unit', 100, 0).worldMerc).toBe(2 * Math.PI * 100)
  })
})
