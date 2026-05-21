// iter-295 — Geodesic interpolation + Haversine distance fuzz.
// Geometric edge cases: antipodal, polar, antimeridian, identical
// endpoints, lon ±180 boundary, t outside [0,1].

import { describe, it, expect } from 'vitest'
import { interpolateGreatCircle, haversineDistance } from './geodesic'

function makeRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13; s |= 0
    s ^= s >>> 17
    s ^= s << 5; s |= 0
    return ((s >>> 0) / 0x1_0000_0000)
  }
}

describe('iter-295 interpolateGreatCircle fuzz', () => {
  it('t=0 returns start point exactly', () => {
    const r = interpolateGreatCircle(126.9, 37.5, -73.9, 40.7, 0)
    expect(r[0]).toBeCloseTo(126.9, 5)
    expect(r[1]).toBeCloseTo(37.5, 5)
  })

  it('t=1 returns end point exactly', () => {
    const r = interpolateGreatCircle(126.9, 37.5, -73.9, 40.7, 1)
    expect(r[0]).toBeCloseTo(-73.9, 5)
    expect(r[1]).toBeCloseTo(40.7, 5)
  })

  it('identical endpoints: every t returns the same point', () => {
    const rng = makeRng(0xc001)
    for (let trial = 0; trial < 50; trial++) {
      const t = rng()
      const r = interpolateGreatCircle(45, 30, 45, 30, t)
      expect(r[0]).toBeCloseTo(45, 5)
      expect(r[1]).toBeCloseTo(30, 5)
    }
  })

  it('output always finite for valid inputs (lon/lat in mercator-safe band)', () => {
    const rng = makeRng(0xbeef)
    for (let trial = 0; trial < 2000; trial++) {
      const lon1 = (rng() * 360) - 180
      const lat1 = (rng() * 170) - 85
      const lon2 = (rng() * 360) - 180
      const lat2 = (rng() * 170) - 85
      const t = rng()
      const r = interpolateGreatCircle(lon1, lat1, lon2, lat2, t)
      if (!Number.isFinite(r[0]) || !Number.isFinite(r[1])) {
        throw new Error(`non-finite: lon1=${lon1} lat1=${lat1} lon2=${lon2} lat2=${lat2} t=${t} → [${r[0]}, ${r[1]}]`)
      }
    }
  })

  it('antimeridian-spanning interpolation: NYC to Seoul (short way over pole)', () => {
    // NYC = -73.9, 40.7; Seoul = 126.9, 37.5; great circle goes over
    // the north pole (shorter than around the equator).
    const r = interpolateGreatCircle(-73.9, 40.7, 126.9, 37.5, 0.5)
    // Midpoint latitude should be high (near pole), not at the
    // equator (which a naive linear interp would produce).
    expect(Math.abs(r[1])).toBeGreaterThan(60)
  })

  it('antipodal points: result is finite (slerp ambiguous but should not NaN)', () => {
    // Antipodes (0,0) and (180,0) — slerp ambiguous direction, but
    // should not produce NaN. (Antipode of a point can take any path.)
    const r = interpolateGreatCircle(0, 0, 180, 0, 0.5)
    expect(Number.isFinite(r[0])).toBe(true)
    expect(Number.isFinite(r[1])).toBe(true)
  })

  it('north pole interpolation: any lon → lat=90', () => {
    const r = interpolateGreatCircle(0, 90, 100, 90, 0.5)
    expect(r[1]).toBeCloseTo(90, 3)
  })

  it('south pole interpolation: any lon → lat=-90', () => {
    const r = interpolateGreatCircle(0, -90, 100, -90, 0.5)
    expect(r[1]).toBeCloseTo(-90, 3)
  })

  it('t < 0 / t > 1 still produces finite (extrapolation)', () => {
    const rNeg = interpolateGreatCircle(0, 0, 10, 10, -0.5)
    expect(Number.isFinite(rNeg[0])).toBe(true)
    expect(Number.isFinite(rNeg[1])).toBe(true)
    const rOver = interpolateGreatCircle(0, 0, 10, 10, 1.5)
    expect(Number.isFinite(rOver[0])).toBe(true)
    expect(Number.isFinite(rOver[1])).toBe(true)
  })

  it('symmetric: midpoint(A, B) == midpoint(B, A) (up to lon sign)', () => {
    const mAB = interpolateGreatCircle(10, 20, 100, 50, 0.5)
    const mBA = interpolateGreatCircle(100, 50, 10, 20, 0.5)
    expect(mAB[1]).toBeCloseTo(mBA[1], 6)
    expect(mAB[0]).toBeCloseTo(mBA[0], 6)
  })

  it('equator-only path lat stays at 0 (no drift)', () => {
    const rng = makeRng(0xeee)
    for (let trial = 0; trial < 20; trial++) {
      const lon1 = (rng() * 360) - 180
      const lon2 = (rng() * 360) - 180
      const t = rng()
      const r = interpolateGreatCircle(lon1, 0, lon2, 0, t)
      expect(Math.abs(r[1])).toBeLessThan(1e-9)
    }
  })

  it('same-meridian path lon stays constant (when crossing pole forbidden)', () => {
    // Both points on prime meridian, same hemisphere — path stays
    // on the meridian.
    const r = interpolateGreatCircle(45, 10, 45, 60, 0.5)
    expect(r[0]).toBeCloseTo(45, 4)
    expect(r[1]).toBeCloseTo(35, 0)  // approx midpoint lat
  })

  // iter-302 — mutation testing surfaced surviving mutants on the
  // d < 1e-12 linear-fallback path. Identical-endpoint tests above
  // only probed t=0/t=1 (degenerate), so a mutation of
  // `(lon2 - lon1) * t` / `lat1 + …` survives because the difference
  // term is zero either way. Add a NEAR-coincident probe with NON-
  // identical endpoints so the linear interp arithmetic is actually
  // exercised.
  it('iter-302: near-coincident (but not identical) endpoints linear-interp correctly at mid-t', () => {
    // Points 1e-13 apart in lat — well below the 1e-12 epsilon, so
    // the fallback fires. The interior t should produce a linear
    // blend, NOT clamp to start/end.
    const lon1 = 30, lat1 = 45
    const lon2 = 30 + 1e-13, lat2 = 45 + 1e-13
    const t = 0.5
    const r = interpolateGreatCircle(lon1, lat1, lon2, lat2, t)
    // Result must be the linear midpoint, not lon1 or lon2 alone.
    expect(r[0]).toBeCloseTo(lon1 + (lon2 - lon1) * t, 15)
    expect(r[1]).toBeCloseTo(lat1 + (lat2 - lat1) * t, 15)
  })

  it('iter-302: same near-coincident probe at t=0.25 + t=0.75 distinguishes sign mutants', () => {
    const lon1 = 30, lat1 = 45
    const lon2 = 30 + 1e-13, lat2 = 45 + 1e-13
    const r25 = interpolateGreatCircle(lon1, lat1, lon2, lat2, 0.25)
    const r75 = interpolateGreatCircle(lon1, lat1, lon2, lat2, 0.75)
    // Closer to start at t=0.25, closer to end at t=0.75. Mutating
    // `+` → `-` inside the fallback would invert this ordering.
    expect(r25[0]).toBeLessThan(r75[0])
    expect(r25[1]).toBeLessThan(r75[1])
  })
})

describe('iter-295 haversineDistance fuzz', () => {
  it('zero distance for identical points', () => {
    expect(haversineDistance(126.9, 37.5, 126.9, 37.5)).toBe(0)
  })

  it('symmetric: dist(A, B) === dist(B, A)', () => {
    const rng = makeRng(0x1234)
    for (let trial = 0; trial < 200; trial++) {
      const lon1 = (rng() * 360) - 180
      const lat1 = (rng() * 170) - 85
      const lon2 = (rng() * 360) - 180
      const lat2 = (rng() * 170) - 85
      const d1 = haversineDistance(lon1, lat1, lon2, lat2)
      const d2 = haversineDistance(lon2, lat2, lon1, lat1)
      expect(d1).toBeCloseTo(d2, 3)
    }
  })

  it('always non-negative', () => {
    const rng = makeRng(0x5555)
    for (let trial = 0; trial < 500; trial++) {
      const d = haversineDistance(
        (rng() * 360) - 180, (rng() * 170) - 85,
        (rng() * 360) - 180, (rng() * 170) - 85,
      )
      expect(d).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(d)).toBe(true)
    }
  })

  it('upper-bound: any two points are within half Earth circumference', () => {
    // Earth circumference ≈ 40,075 km. Max great-circle distance =
    // half = 20,037 km. Any output > 20,037,500 m is a bug.
    const MAX = 20_037_500
    const rng = makeRng(0x9999)
    for (let trial = 0; trial < 500; trial++) {
      const d = haversineDistance(
        (rng() * 360) - 180, (rng() * 170) - 85,
        (rng() * 360) - 180, (rng() * 170) - 85,
      )
      expect(d).toBeLessThanOrEqual(MAX)
    }
  })

  it('1° lat ≈ 111 km (known reference)', () => {
    const d = haversineDistance(0, 0, 0, 1)
    expect(d).toBeGreaterThan(110000)
    expect(d).toBeLessThan(112000)
  })

  it('1° lon at equator ≈ 111 km', () => {
    const d = haversineDistance(0, 0, 1, 0)
    expect(d).toBeGreaterThan(110000)
    expect(d).toBeLessThan(112000)
  })

  it('1° lon at lat=60 ≈ half-equator km (cos(60°))', () => {
    const dEq = haversineDistance(0, 0, 1, 0)
    const d60 = haversineDistance(0, 60, 1, 60)
    // cos(60°) = 0.5, so d60 ≈ dEq / 2
    expect(d60 / dEq).toBeCloseTo(0.5, 2)
  })

  it('lon ±180 antimeridian: 0° lat → 0° lat across antimeridian is short', () => {
    // (-180, 0) and (180, 0) are SAME point. Distance should be ~0.
    const d = haversineDistance(-180, 0, 180, 0)
    expect(d).toBeLessThan(1)  // sub-meter
  })

  it('antipode: distance equals half Earth circumference', () => {
    const d = haversineDistance(0, 0, 180, 0)
    const halfC = Math.PI * 6378137  // π R
    expect(d).toBeCloseTo(halfC, -2)
  })
})
