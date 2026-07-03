// Characterization / guard suite for the @xgis/shared single-source-of-truth
// coordinate kernel. These functions are imported byte-for-byte by both
// @xgis/compiler (tiler) and @xgis/runtime (engine); the bit-equality contract
// was previously asserted only in prose (AGENTS.md / README.md / ecef.ts
// header). This suite pins the three load-bearing numeric contracts so a future
// edit to the kernel trips a co-located test instead of only a far-away
// consumer suite. Bounds are derived from the actual constants in ecef.ts
// (A = 6378137, 1/F = 298.257223563), not invented.

import { describe, expect, it } from 'vitest'
import { lonLatToECEF, ecefToLonLat, lonLatToECEFSphere, WGS84 } from './ecef'
import { quantizeAxis } from './quantize'

const { A, F, E2 } = WGS84

describe('ecef forward/inverse round-trip', () => {
  // Equator, mid-latitude, near-edge (85deg) — the bands a tile pipeline
  // actually visits. Pole is exercised separately (it hits the p<1e-9 guard).
  const lats = [0, 45, 85]
  const lons = [-179.9, 0, 120.5, 179.9]
  const heights = [0, 1000]

  it('returns lon/lat/height to sub-nano-degree / sub-micron precision', () => {
    for (const lat of lats) {
      for (const lon of lons) {
        for (const height of heights) {
          const [x, y, z] = lonLatToECEF(lon, lat, height)
          const [rLon, rLat, rHeight] = ecefToLonLat(x, y, z)
          // Measured worst case across this grid: |dlat|~1.4e-14 deg,
          // |dlon|~4.3e-14 deg, |dh|~2e-6 m. Bounds below sit several orders
          // above the measured error so platform float jitter never flakes,
          // yet a real formula regression (wrong eccentricity, dropped term)
          // blows past them immediately.
          expect(Math.abs(rLat - lat)).toBeLessThan(1e-9)
          expect(Math.abs(rLon - lon)).toBeLessThan(1e-9)
          expect(Math.abs(rHeight - height)).toBeLessThan(1e-3)
        }
      }
    }
  })

  it('resolves the exact pole via the polar-singularity guard', () => {
    // At lat=90 the forward z collapses to the semi-minor axis b = A*(1-F):
    //   z = N*(1-E2) where N = A/sqrt(1-E2)  =>  z = A*sqrt(1-E2) = b.
    const b = A * (1 - F)
    const [, , zNorth] = lonLatToECEF(0, 90, 0)
    expect(zNorth).toBeCloseTo(b, 6)

    // Inverse at the spin axis must short-circuit to lat=+/-90, lon=0, h=0
    // (not NaN — see ecef.ts ecefToLonLat p<1e-9 branch).
    const [lonN, latN, hN] = ecefToLonLat(0, 0, b)
    expect(lonN).toBe(0)
    expect(latN).toBe(90)
    expect(hN).toBeCloseTo(0, 6)

    const [lonS, latS, hS] = ecefToLonLat(0, 0, -b)
    expect(lonS).toBe(0)
    expect(latS).toBe(-90)
    expect(hS).toBeCloseTo(0, 6)
  })
})

describe('ellipsoid vs sphere ECEF split (the documented ~21 km flattening)', () => {
  it('is exactly zero at the equator (dual-path parity contract)', () => {
    // ecef.ts header: at lat=0, cos(0)=1 makes the ellipsoid and sphere paths
    // mathematically identical, which the Phase 2 dual-path parity gate relies
    // on. Pin it to bit-equality.
    const ell = lonLatToECEF(0, 0, 0)
    const sph = lonLatToECEFSphere(0, 0, 0)
    expect(ell[0]).toBe(sph[0])
    expect(ell[1]).toBe(sph[1])
    expect(ell[2]).toBe(sph[2])
  })

  it('is A*(1 - sqrt(1-E2)) ~= 21.38 km on the polar z-axis', () => {
    // The "~21 km of polar flattening" called out in ecef.ts:14 and AGENTS.md.
    // Sphere z at the pole is A; ellipsoid z is A*sqrt(1-E2). The split is the
    // difference of the two, which equals A minus the semi-minor axis b.
    const ellZ = lonLatToECEF(0, 90, 0)[2]
    const sphZ = lonLatToECEFSphere(0, 90, 0)[2]
    const split = sphZ - ellZ

    const expected = A * (1 - Math.sqrt(1 - E2)) // = 21384.6858 m
    expect(split).toBeCloseTo(expected, 6)

    // Guard the magnitude band ("~21 km") so a constant drift (e.g. someone
    // zeroing E2 in the ellipsoid path) is caught, not just an exact-value
    // change.
    expect(split).toBeGreaterThan(21_000)
    expect(split).toBeLessThan(22_000)

    // And it must equal A - b where b is the WGS84 semi-minor axis.
    const b = A * (1 - F)
    expect(split).toBeCloseTo(A - b, 6)
  })
})

describe('quantizeAxis lane bounds stay valid u16', () => {
  // halfRange = exact max-abs over the tile verts (+eps); invSpan maps
  // [-halfRange, +halfRange] onto the full u32 range. Each returned lane is a
  // u16 and must stay within [0, 0xFFFF] at both ends and under overshoot.
  const halfRange = 1000
  const invSpan = 0xffffffff / (2 * halfRange)

  function expectU16Lanes([hi, lo]: [number, number]) {
    expect(Number.isInteger(hi)).toBe(true)
    expect(Number.isInteger(lo)).toBe(true)
    expect(hi).toBeGreaterThanOrEqual(0)
    expect(hi).toBeLessThanOrEqual(0xffff)
    expect(lo).toBeGreaterThanOrEqual(0)
    expect(lo).toBeLessThanOrEqual(0xffff)
  }

  it('maps the negative extreme to [0, 0]', () => {
    const lanes = quantizeAxis(-halfRange, halfRange, invSpan)
    expectU16Lanes(lanes)
    expect(lanes).toEqual([0, 0])
  })

  it('maps the positive extreme to [0xFFFF, 0xFFFF]', () => {
    const lanes = quantizeAxis(halfRange, halfRange, invSpan)
    expectU16Lanes(lanes)
    expect(lanes).toEqual([0xffff, 0xffff])
    // Recombined u32 = full range ceiling 0xFFFFFFFF.
    expect((((lanes[0] << 16) >>> 0) | lanes[1]) >>> 0).toBe(0xffffffff)
  })

  it('clamps overshoot at both ends to valid u16 lanes', () => {
    expectU16Lanes(quantizeAxis(-halfRange - 5, halfRange, invSpan))
    expect(quantizeAxis(-halfRange - 5, halfRange, invSpan)).toEqual([0, 0])
    expectU16Lanes(quantizeAxis(halfRange + 5, halfRange, invSpan))
    expect(quantizeAxis(halfRange + 5, halfRange, invSpan)).toEqual([0xffff, 0xffff])
  })
})
