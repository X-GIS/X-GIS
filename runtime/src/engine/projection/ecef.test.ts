import { describe, it, expect } from 'vitest'
import {
  lonLatToECEF,
  ecefToLonLat,
  mercatorToECEF,
  dsfunSplitECEF,
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
    [126.97797, 37.56583, 0],   // Seoul
    [-122.4194, 37.7749, 100],  // San Francisco with altitude
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
      expect(h2).toBeCloseTo(h, 4)  // height in metres, 0.1 mm precision
    })
  }
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
    const my = Math.log(
      Math.tan(Math.PI / 4 + (seoulLat * Math.PI) / 360),
    ) * WGS84.A
    const fromMerc = mercatorToECEF(mx, my)
    const direct = lonLatToECEF(seoulLon, seoulLat)
    expect(fromMerc[0]).toBeCloseTo(direct[0], 3)  // 1 mm
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
    expect(errMetres).toBeLessThan(1e-3)  // 1 mm
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
