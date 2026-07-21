// ═══ eyeHorizon — ellipsoid tangent-plane exactness / sphere reduction (#1152 INC-3) ═══
//
// The generalized authority `eyeHorizon(eye, a, b)` must (a) be EXACT: for any eye E
// and surface point P on the (a,a,b) ellipsoid, the scaled-frame horizon predicate
// `P·k > horizonCos` (k = (eyeN.x/a, eyeN.y/a, eyeN.z/b)) has the SAME sign as the
// closed-form geodetic tangent-plane test `n̂_geodetic·(E−P) > 0`; (b) DEGENERATE
// bit-for-bit to the retired sphere formula when b = a (Moon / any sphereR); and
// (c) be invariant to a/b for an equatorial eye (eye.z = 0 ⇒ the z-stretch is inert).

import { describe, it, expect } from 'vitest'
import { EARTH, MOON } from './body'
import { lonLatToECEF, eyeHorizon } from './ecef'

const DEG = Math.PI / 180
const A = EARTH.a
const B = EARTH.b
type V3 = readonly [number, number, number]
const geodeticNormal = (lonDeg: number, latDeg: number): V3 => {
  const lam = lonDeg * DEG,
    phi = latDeg * DEG,
    c = Math.cos(phi)
  return [c * Math.cos(lam), c * Math.sin(lam), Math.sin(phi)]
}
/** A geocentric-direction eye at |eye| = A·mult (any point above the ellipsoid). */
const eyeAt = (lonDeg: number, latDeg: number, mult: number): V3 => {
  const n = geodeticNormal(lonDeg, latDeg)
  return [n[0] * A * mult, n[1] * A * mult, n[2] * A * mult]
}

const SURF: V3[] = []
for (let lat = -85; lat <= 85; lat += 17)
  for (let lon = -170; lon <= 170; lon += 40) SURF.push(lonLatToECEF(lon, lat) as unknown as V3)

const EYES: V3[] = []
for (const [elon, elat] of [
  [0, 0],
  [30, 60],
  [-100, -40],
  [170, 80],
  [12, 12],
] as const)
  for (const mult of [1.05, 1.4, 2.5, 8]) EYES.push(eyeAt(elon, elat, mult))

describe('eyeHorizon ellipsoid exactness (#1152 INC-3)', () => {
  it('scaled-frame predicate sign === geodetic tangent-plane predicate sign (exact)', () => {
    let checked = 0
    let mism = 0
    for (const E of EYES) {
      const { eyeN, horizonCos } = eyeHorizon(E, A, B)
      const k: V3 = [eyeN[0] / A, eyeN[1] / A, eyeN[2] / B]
      for (const P of SURF) {
        // Exact tangent-plane oracle: geodetic normal at P · (E − P).
        // Recover (lon,lat) from P to get n̂ — but P came from a known (lon,lat) grid,
        // so use the position directly: n̂ ∝ (P.x/a², P.y/a², P.z/b²).
        const g: V3 = [P[0] / (A * A), P[1] / (A * A), P[2] / (B * B)]
        const oracle = g[0] * (E[0] - P[0]) + g[1] * (E[1] - P[1]) + g[2] * (E[2] - P[2])
        const scaled = P[0] * k[0] + P[1] * k[1] + P[2] * k[2] - horizonCos
        // Skip the measure-zero grazing band (either signal within 1e-6 of 0).
        const gl = Math.hypot(g[0], g[1], g[2])
        if (Math.abs(oracle) < 1e-6 * A * gl || Math.abs(scaled) < 1e-9) continue
        checked++
        if (oracle > 0 !== scaled > 0) mism++
      }
    }
    expect(checked).toBeGreaterThan(100) // non-vacuous
    expect(mism).toBe(0)
  })

  it('front/back split is genuinely exercised (not all-visible / all-culled)', () => {
    let front = 0
    let back = 0
    for (const E of EYES) {
      const { eyeN, horizonCos } = eyeHorizon(E, A, B)
      const k: V3 = [eyeN[0] / A, eyeN[1] / A, eyeN[2] / B]
      for (const P of SURF) {
        if (P[0] * k[0] + P[1] * k[1] + P[2] * k[2] > horizonCos) front++
        else back++
      }
    }
    expect(front).toBeGreaterThan(0)
    expect(back).toBeGreaterThan(0)
  })

  it('b = a (Moon / sphere) reduces bit-for-bit to the retired sphere formula', () => {
    const bad: string[] = []
    for (const r of [MOON.a, EARTH.a, 1000, 6.371e6]) {
      for (const E of EYES) {
        const h = eyeHorizon(E, r, r) // b === a
        // Retired sphere formula: { |eye|, eye/|eye|, r/|eye| }.
        const eyeLen = Math.hypot(E[0], E[1], E[2])
        if (
          !Object.is(h.eyeLen, eyeLen) ||
          !Object.is(h.eyeN[0], E[0] / eyeLen) ||
          !Object.is(h.eyeN[1], E[1] / eyeLen) ||
          !Object.is(h.eyeN[2], E[2] / eyeLen) ||
          !Object.is(h.horizonCos, r / eyeLen)
        )
          bad.push(`r=${r} eye=${E.join(',')}`)
      }
    }
    expect(bad, `sphere reduction diverged at: ${bad.join('; ')}`).toEqual([])
  })

  it('equatorial eye (eye.z = 0): a/b is inert — ellipsoid === sphere lanes bit-for-bit', () => {
    const bad: string[] = []
    for (const eq of [
      [A * 1.5, 0, 0],
      [0, A * 3, 0],
      [A * 1.2, -A * 2.1, 0],
      [-A * 4, A * 0.7, 0],
    ] as V3[]) {
      const ell = eyeHorizon(eq, A, B) // z-stretch touches only z, which is 0
      const sph = eyeHorizon(eq, A, A)
      if (
        !Object.is(ell.eyeLen, sph.eyeLen) ||
        !Object.is(ell.eyeN[0], sph.eyeN[0]) ||
        !Object.is(ell.eyeN[1], sph.eyeN[1]) ||
        !Object.is(ell.eyeN[2], sph.eyeN[2]) ||
        !Object.is(ell.horizonCos, sph.horizonCos)
      )
        bad.push(eq.join(','))
    }
    expect(bad, `equatorial invariance diverged at: ${bad.join('; ')}`).toEqual([])
  })
})
