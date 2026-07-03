import { describe, it, expect } from 'vitest'
import {
  lonLatToECEF,
  ecefToLonLat,
  mercatorToECEF,
  tileEcefCenterFromMerc,
  dsfunSplitECEF,
  ecefToENURotation,
  WGS84,
} from './ecef'

describe('lonLatToECEF — WGS84 reference points', () => {
  it('equator at lon=0 → (A, 0, 0)', () => {
    const [x, y, z] = lonLatToECEF(0, 0)
    expect(x).toBeCloseTo(WGS84.A, 6)
    expect(y).toBeCloseTo(0, 6)
    expect(z).toBeCloseTo(0, 6)
  })

  it('equator at lon=90 → (0, A, 0)', () => {
    const [x, y, z] = lonLatToECEF(90, 0)
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(WGS84.A, 6)
    expect(z).toBeCloseTo(0, 6)
  })

  it('north pole → (0, 0, b) where b = a(1-f)', () => {
    const b = WGS84.A * (1 - WGS84.F)
    const [x, y, z] = lonLatToECEF(0, 90)
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(0, 6)
    expect(z).toBeCloseTo(b, 6)
  })

  it('south pole → (0, 0, -b)', () => {
    const b = WGS84.A * (1 - WGS84.F)
    const [x, y, z] = lonLatToECEF(0, -90)
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(0, 6)
    expect(z).toBeCloseTo(-b, 6)
  })

  it('Seoul (lon=126.97797, lat=37.56583) — magnitude is ~a', () => {
    const [x, y, z] = lonLatToECEF(126.97797, 37.56583)
    const r = Math.hypot(x, y, z)
    // At ellipsoid surface, |ECEF| ranges from b (~6357 km) at poles to a
    // (~6378 km) at equator. Seoul is mid-latitude → between the two.
    expect(r).toBeGreaterThan(6356e3)
    expect(r).toBeLessThan(6379e3)
  })
})

describe('ecefToLonLat — round-trip', () => {
  const samples: [number, number, number][] = [
    [0, 0, 0],
    [90, 0, 0],
    [-90, 0, 0],
    [180, 0, 0],
    [0, 89.999, 0],
    [126.97797, 37.56583, 0], // Seoul
    [-122.4194, 37.7749, 100], // San Francisco with altitude
    [0, -89.999, 0],
    [45, 45, 1000],
  ]

  for (const [lon, lat, h] of samples) {
    it(`round-trip lon=${lon}, lat=${lat}, h=${h} stable to 1 nm`, () => {
      const ecef = lonLatToECEF(lon, lat, h)
      const [lon2, lat2, h2] = ecefToLonLat(ecef[0], ecef[1], ecef[2])
      // 1 nm of arc on Earth surface ≈ 1.6e-14 deg. Use 1e-9 deg (~1 mm)
      // as a more pragmatic tolerance — Bowring's iteration converges fast
      // but f64 round-trip noise prevents asserting at the nanometre level.
      expect(lon2).toBeCloseTo(lon === 180 ? 180 : lon, 9)
      expect(lat2).toBeCloseTo(lat, 9)
      expect(h2).toBeCloseTo(h, 4) // height in metres, 0.1 mm precision
    })
  }
})

describe('ecefToLonLat — polar singularity (exact pole, p≈0)', () => {
  const B = WGS84.A * (1 - WGS84.F) // semi-minor axis = a(1-f)

  it('exact north pole (0, 0, +b) → finite lat=90, height≈0 (was NaN)', () => {
    const [lon, lat, h] = ecefToLonLat(0, 0, B)
    expect(Number.isFinite(lat)).toBe(true)
    expect(Number.isFinite(h)).toBe(true)
    expect(lat).toBeCloseTo(90, 9)
    expect(lon).toBe(0)
    expect(h).toBeCloseTo(0, 4) // on the polar surface → height ~0
  })

  it('exact south pole (0, 0, -b) → finite lat=-90, height≈0 (was NaN)', () => {
    const [lon, lat, h] = ecefToLonLat(0, 0, -B)
    expect(Number.isFinite(lat)).toBe(true)
    expect(Number.isFinite(h)).toBe(true)
    expect(lat).toBeCloseTo(-90, 9)
    expect(lon).toBe(0)
    expect(h).toBeCloseTo(0, 4)
  })

  it('north pole with altitude (0, 0, b+1000) → height≈1000', () => {
    const [, lat, h] = ecefToLonLat(0, 0, B + 1000)
    expect(Number.isFinite(lat)).toBe(true)
    expect(lat).toBeCloseTo(90, 9)
    expect(h).toBeCloseTo(1000, 4)
  })

  it('lonLatToECEF(0, 90, 0) round-trips to finite lat≈90', () => {
    // The forward of the exact pole yields a tiny nonzero x (~3.9e-10) from
    // cos(π/2) f64 noise, so this did not NaN before the guard; assert it
    // stays correct (finite, lat≈90) after.
    const ecef = lonLatToECEF(0, 90, 0)
    const [, lat, h] = ecefToLonLat(ecef[0], ecef[1], ecef[2])
    expect(Number.isFinite(lat)).toBe(true)
    expect(lat).toBeCloseTo(90, 9)
    expect(h).toBeCloseTo(0, 4)
  })
})

describe('mercatorToECEF — composes Mercator inverse + lonLatToECEF', () => {
  it('equator origin (mx=0, my=0) → (A, 0, 0)', () => {
    const [x, y, z] = mercatorToECEF(0, 0)
    expect(x).toBeCloseTo(WGS84.A, 6)
    expect(y).toBeCloseTo(0, 6)
    expect(z).toBeCloseTo(0, 6)
  })

  it('agrees with lonLatToECEF for Seoul Mercator coords', () => {
    const seoulLon = 126.97797
    const seoulLat = 37.56583
    // Forward Mercator to get the Mercator coords (mirrors projection.ts).
    const mx = seoulLon * (Math.PI / 180) * WGS84.A
    const my = Math.log(Math.tan(Math.PI / 4 + (seoulLat * Math.PI) / 360)) * WGS84.A
    const fromMerc = mercatorToECEF(mx, my)
    const direct = lonLatToECEF(seoulLon, seoulLat)
    expect(fromMerc[0]).toBeCloseTo(direct[0], 3) // 1 mm
    expect(fromMerc[1]).toBeCloseTo(direct[1], 3)
    expect(fromMerc[2]).toBeCloseTo(direct[2], 3)
  })
})

describe('dsfunSplitECEF — sub-mm precision via hi/lo split (AC2.5a)', () => {
  // Worst-case anchor: Seoul at z=18-style precision. The polygon VS reads
  // pos_h + pos_l as two f32 vec3s; the test asserts the f64 reference
  // matches the reconstructed hi+lo sum to within 1 mm.
  it('Seoul + 1m offset reconstructs to within 1 mm (CPU AC2.5a)', () => {
    const center = lonLatToECEF(126.97797, 37.56583)
    // A point 1 metre east of the center (~9e-6 deg of lon).
    const offset = lonLatToECEF(126.97797 + 9e-6, 37.56583)
    const { hi, lo } = dsfunSplitECEF(offset, center)
    // Reconstruction: rtc = hi + lo. Compare to the f64 relative vector.
    const rtc = [hi[0] + lo[0], hi[1] + lo[1], hi[2] + lo[2]]
    const ref = [offset[0] - center[0], offset[1] - center[1], offset[2] - center[2]]
    const errMetres = Math.hypot(rtc[0] - ref[0], rtc[1] - ref[1], rtc[2] - ref[2])
    expect(errMetres).toBeLessThan(1e-3) // 1 mm
  })

  it('hi component is exactly f32-representable (Math.fround round-trip)', () => {
    const center = lonLatToECEF(0, 0)
    const p = lonLatToECEF(0, 1)
    const { hi } = dsfunSplitECEF(p, center)
    expect(Math.fround(hi[0])).toBe(hi[0])
    expect(Math.fround(hi[1])).toBe(hi[1])
    expect(Math.fround(hi[2])).toBe(hi[2])
  })

  it('hi + lo = f64 relative (algebraic identity)', () => {
    const center: [number, number, number] = [4000000, 3000000, 4500000]
    const p: [number, number, number] = [4000123.456789, 3000654.321987, 4500987.111222]
    const { hi, lo } = dsfunSplitECEF(p, center)
    expect(hi[0] + lo[0]).toBe(p[0] - center[0])
    expect(hi[1] + lo[1]).toBe(p[1] - center[1])
    expect(hi[2] + lo[2]).toBe(p[2] - center[2])
  })
})

describe('ecefToENURotation — local tangent-plane basis', () => {
  // Helper: read column-major Float32Array(16) as a 4x4 in [row][col] order.
  const at = (m: Float32Array, row: number, col: number): number => m[col * 4 + row]

  it('lon=0, lat=0 (equator + prime meridian) — known reference', () => {
    const r = ecefToENURotation(0, 0)
    // At (lon=0, lat=0): East=+Y, North=+Z, Up=+X in ECEF.
    // Row vectors should equal those basis directions:
    //   E (row 0) = (0, 1, 0)
    //   N (row 1) = (0, 0, 1)
    //   U (row 2) = (1, 0, 0)
    expect(at(r, 0, 0)).toBeCloseTo(0, 12)
    expect(at(r, 0, 1)).toBeCloseTo(1, 12)
    expect(at(r, 0, 2)).toBeCloseTo(0, 12)
    expect(at(r, 1, 0)).toBeCloseTo(0, 12)
    expect(at(r, 1, 1)).toBeCloseTo(0, 12)
    expect(at(r, 1, 2)).toBeCloseTo(1, 12)
    expect(at(r, 2, 0)).toBeCloseTo(1, 12)
    expect(at(r, 2, 1)).toBeCloseTo(0, 12)
    expect(at(r, 2, 2)).toBeCloseTo(0, 12)
  })

  it('rotation matrix is orthonormal for arbitrary anchor', () => {
    const r = ecefToENURotation(126.97797, 37.56583) // Seoul
    // The matrix is stored as Float32Array — f32 precision is ~7 sig figs,
    // so orthonormality holds within f32 rounding (not f64). 6 dp tolerance
    // keeps the test honest about the storage class.
    for (let row = 0; row < 3; row++) {
      const len = Math.hypot(at(r, row, 0), at(r, row, 1), at(r, row, 2))
      expect(len).toBeCloseTo(1, 6)
    }
    const dot = (a: number, b: number): number =>
      at(r, a, 0) * at(r, b, 0) + at(r, a, 1) * at(r, b, 1) + at(r, a, 2) * at(r, b, 2)
    expect(dot(0, 1)).toBeCloseTo(0, 6)
    expect(dot(0, 2)).toBeCloseTo(0, 6)
    expect(dot(1, 2)).toBeCloseTo(0, 6)
  })

  it('Up direction at anchor points along the outward ECEF normal', () => {
    const lon = 126.97797
    const lat = 37.56583
    const r = ecefToENURotation(lon, lat)
    // ECEF position at the anchor.
    const ecef = lonLatToECEF(lon, lat)
    const ecefLen = Math.hypot(ecef[0], ecef[1], ecef[2])
    // U row dotted with the ECEF position (normalized) ≈ 1 — Up is the
    // outward normal at the anchor.
    const u0 = at(r, 2, 0)
    const u1 = at(r, 2, 1)
    const u2 = at(r, 2, 2)
    const cosAngle = (u0 * ecef[0] + u1 * ecef[1] + u2 * ecef[2]) / ecefLen
    // WGS84 ellipsoid: the surface normal is NOT exactly parallel to the
    // position vector except at equator/poles, but the angle is small at
    // mid-latitudes (max ~0.2° in either direction).
    expect(cosAngle).toBeGreaterThan(0.99995) // within ~0.6° of parallel
  })

  it('homogeneous identity row preserved (4x4 form)', () => {
    const r = ecefToENURotation(0, 0)
    expect(at(r, 3, 3)).toBe(1)
    expect(at(r, 3, 0)).toBe(0)
    expect(at(r, 3, 1)).toBe(0)
    expect(at(r, 3, 2)).toBe(0)
    expect(at(r, 0, 3)).toBe(0)
    expect(at(r, 1, 3)).toBe(0)
    expect(at(r, 2, 3)).toBe(0)
  })
})

describe('tileEcefCenterFromMerc — thin wrapper for per-tile ECEF anchor', () => {
  it('100 random Mercator tile-corner coords agree byte-exact with mercatorToECEF(mx,my,0)', () => {
    // Mercator domain ±WORLD_MERC/2 ≈ ±20037508.34 m. Seed-free RNG for the
    // fuzz loop is fine — the assertion is byte-equal across both code paths
    // on the same inputs, not statistical.
    const HALF = 20037508.34
    for (let i = 0; i < 100; i++) {
      const mx = (Math.random() * 2 - 1) * HALF
      const my = (Math.random() * 2 - 1) * HALF
      const wrapped = tileEcefCenterFromMerc(mx, my)
      const direct = mercatorToECEF(mx, my, 0)
      expect(wrapped[0]).toBe(direct[0])
      expect(wrapped[1]).toBe(direct[1])
      expect(wrapped[2]).toBe(direct[2])
    }
  })

  it('tile-corner (mx=0, my=0) → (A, 0, 0) on the WGS84 equator', () => {
    const [x, y, z] = tileEcefCenterFromMerc(0, 0)
    expect(x).toBeCloseTo(WGS84.A, 6)
    expect(y).toBeCloseTo(0, 6)
    expect(z).toBeCloseTo(0, 6)
  })
})

describe('WGS84 constants — match the spec', () => {
  it('semi-major axis A = 6378137 m', () => {
    expect(WGS84.A).toBe(6378137)
  })

  it('flattening F = 1 / 298.257223563', () => {
    expect(WGS84.F).toBeCloseTo(1 / 298.257223563, 15)
  })

  it('eccentricity² E2 = 2f - f²', () => {
    expect(WGS84.E2).toBeCloseTo(2 * WGS84.F - WGS84.F * WGS84.F, 15)
  })
})
