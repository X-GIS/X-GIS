// ═══ Round-trip pins for the azimuthal disc inverses (camera-helpers) ═══
//
// zoomAt's disc geo-anchor (camera.ts:917) trusts these inverses to recover
// the geographic point under the fingers from disc-plane metres. A wrong-
// convention inverse (different R / centre handling / ρ→c map than the
// codebase forward in projection.ts) leaves a systematic residual that G3b
// (interaction-contract-gates.test.ts) would surface as anchor slide — these
// pins fail FIRST, at the math layer, naming the broken formula.
//
// Direction 1 (geo→plane→geo): inv(forward(λ,φ)) ≈ (λ,φ) to ≤ 1e-9 rad over
// a grid of projection centres (equatorial / mid / high-latitude / southern)
// × geographic offsets out to near-limb angular distances. The codebase
// forward is the CPU canonical `getProjection(name, lon0, lat0).forward`
// (degrees); the inverses under test are the radian helpers zoomAt calls.
// Direction 2 (plane→geo→plane): forward(inv(x,y)) ≈ (x,y) to ≤ 1e-3 m over
// disc-plane radii out to each projection's near-limb region (azimuthal-eq:
// c ≤ 2.9 rad of its ρ=πR antipode domain; stereographic: c ≤ 2.65 rad,
// inside its cos c ≥ −0.9 forward cull) — sub-mm against plane coordinates
// of up to ~5·10⁷ m.

import { describe, it, expect } from 'vitest'
import {
  invOrthographic,
  invAzimuthalEquidistant,
  invStereographic,
  discAnchorFor,
} from './camera-helpers'
import { getProjection } from './projection'

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const R = 6378137 // same radius the helpers + projection.ts hardcode

// Projection centres (degrees): equator, mid-lat, high-lat (75/85), southern.
const CENTRES: Array<[number, number]> = [
  [0, 0], [0, 20], [120, 45], [-60, 75], [10, 85], [-170, -60],
]

// Geographic offsets (degrees) from each centre — near-origin (but past the
// azimuthal-equidistant forward's c < 1e-4 rad origin collapse), mid-range,
// and far/near-limb. Lon offsets reach 150° so high-lat centres produce
// angular distances c > 2 rad (the near-limb regime the anti-vacuous guard
// below requires).
const OFFSETS: Array<[number, number]> = [
  [0.05, 0.05], [5, 3], [-10, 8], [20, -15], [45, 25], [-60, -30],
  [90, 10], [-120, 20], [150, -5], [0, 40], [0, -50],
]

/** Angular distance c (radians) between two lon/lat points (degrees). */
function angularDist(lon0: number, lat0: number, lon: number, lat: number): number {
  const p0 = lat0 * DEG2RAD, p1 = lat * DEG2RAD, dl = (lon - lon0) * DEG2RAD
  const cosC = Math.sin(p0) * Math.sin(p1) + Math.cos(p0) * Math.cos(p1) * Math.cos(dl)
  return Math.acos(Math.max(-1, Math.min(1, cosC)))
}

const GEO_TOL_RAD = 1e-9
const PLANE_TOL_M = 1e-3

type Inv = (x: number, y: number, lon0: number, lat0: number) => [number, number]

const CASES: Array<{ name: string; inv: Inv; maxC: number; planeCs: number[] }> = [
  {
    name: 'azimuthal_equidistant',
    inv: invAzimuthalEquidistant,
    // Whole-sphere domain; stay off the exact antipode (ρ=πR) where lon
    // degenerates. The forward never culls, so maxC only trims the grid.
    maxC: 3.0,
    // Direction-2 plane radii expressed as c = ρ/R (rad). 0.005 ≈ 32 km
    // (past the forward's c<1e-4 origin collapse); 2.9 ≈ 0.92π — beyond
    // the 0.85π zoom-anchor safeRho, still inside the antipode domain.
    planeCs: [0.005, 0.1, 0.5, 1.0, 1.7, 2.4, 2.9],
  },
  {
    name: 'stereographic',
    inv: invStereographic,
    // The codebase forward CULLS at cos c < −0.9 (c ≈ 2.6906) — direction 1
    // skips culled points; keep direction 2 inside the cull so the forward
    // of the recovered point is finite. ρ = 2R·tan(c/2): c=2.65 ⇒ ρ ≈ 8R.
    maxC: 2.65,
    planeCs: [0.005, 0.1, 0.5, 1.0, 1.7, 2.4, 2.65],
  },
]

describe('disc inverse round-trip pins (invAzimuthalEquidistant / invStereographic)', () => {
  for (const { name, inv, maxC, planeCs } of CASES) {
    it(`${name}: inv(forward(λ,φ)) ≈ (λ,φ) to ≤ ${GEO_TOL_RAD} rad incl. high-lat centres + near-limb points`, () => {
      let tested = 0
      let nearLimb = 0
      for (const [lon0, lat0] of CENTRES) {
        const proj = getProjection(name, lon0, lat0)
        const lam0 = lon0 * DEG2RAD, phi0 = lat0 * DEG2RAD
        for (const [dLon, dLat] of OFFSETS) {
          const lon = lon0 + dLon
          const lat = Math.max(-89.9, Math.min(89.9, lat0 + dLat))
          const c = angularDist(lon0, lat0, lon, lat)
          // Outside this projection's well-defined forward domain (or inside
          // the aeqd forward's origin collapse) — a forward artifact, not an
          // inverse-fidelity sample.
          if (c < 1e-4 || c > maxC) continue
          const [x, y] = proj.forward(lon, lat)
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue
          const [lonR, latR] = inv(x, y, lam0, phi0)
          expect(Number.isFinite(lonR), `${name} lon non-finite @centre(${lon0},${lat0}) pt(${lon},${lat})`).toBe(true)
          expect(Number.isFinite(latR), `${name} lat non-finite @centre(${lon0},${lat0}) pt(${lon},${lat})`).toBe(true)
          const dLat2 = Math.abs(latR - lat * DEG2RAD)
          expect(dLat2, `${name} lat drift ${dLat2} rad @centre(${lon0},${lat0}) pt(${lon},${lat})`).toBeLessThan(GEO_TOL_RAD)
          // Longitude degenerates at the poles (every meridian collapses) —
          // assert it away from ±89.9° only, wrapped to (−π, π].
          if (Math.abs(lat) < 89.5) {
            let dl = lonR - lon * DEG2RAD
            dl = ((dl + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
            expect(Math.abs(dl), `${name} lon drift ${Math.abs(dl)} rad @centre(${lon0},${lat0}) pt(${lon},${lat})`).toBeLessThan(GEO_TOL_RAD)
          }
          tested++
          if (c > 2) nearLimb++
        }
      }
      // Anti-vacuous guards (G2 pattern): the grid must actually exercise
      // the inverse, including its near-limb regime.
      expect(tested, `${name}: no point survived the forward — vacuous`).toBeGreaterThan(30)
      expect(nearLimb, `${name}: no near-limb (c > 2 rad) point sampled`).toBeGreaterThan(0)
    })

    it(`${name}: forward(inv(x,y)) ≈ (x,y) to ≤ ${PLANE_TOL_M} m out to near-limb plane radii`, () => {
      let tested = 0
      for (const [lon0, lat0] of CENTRES) {
        const proj = getProjection(name, lon0, lat0)
        const lam0 = lon0 * DEG2RAD, phi0 = lat0 * DEG2RAD
        for (const c of planeCs) {
          // ρ from c through THIS projection's radial map (aeqd: R·c;
          // stereo: 2R·tan(c/2)) so both walk comparable angular reach.
          const rho = name === 'stereographic' ? 2 * R * Math.tan(c / 2) : R * c
          for (const thetaDeg of [0, 30, 90, 135, 210, 300]) {
            const t = thetaDeg * DEG2RAD
            const x = rho * Math.cos(t), y = rho * Math.sin(t)
            const [lonR, latR] = inv(x, y, lam0, phi0)
            const [x2, y2] = proj.forward(lonR * RAD2DEG, latR * RAD2DEG)
            if (!Number.isFinite(x2) || !Number.isFinite(y2)) {
              throw new Error(`${name}: forward culled the recovered point @centre(${lon0},${lat0}) c=${c} θ=${thetaDeg}`)
            }
            const d = Math.hypot(x2 - x, y2 - y)
            expect(d, `${name} plane drift ${d} m @centre(${lon0},${lat0}) c=${c} θ=${thetaDeg}`).toBeLessThan(PLANE_TOL_M)
            tested++
          }
        }
      }
      expect(tested, `${name}: plane grid empty — vacuous`).toBeGreaterThan(100)
    })
  }
})

describe('discAnchorFor dispatch (zoomAt disc geo-anchor table)', () => {
  it('maps 3/4/5 to ortho / azimuthal-eq / stereo inverses with their safe radii', () => {
    expect(discAnchorFor(3).inv).toBe(invOrthographic)
    expect(discAnchorFor(4).inv).toBe(invAzimuthalEquidistant)
    expect(discAnchorFor(5).inv).toBe(invStereographic)
    // safeRho = 85% of each inverse's degeneracy radius (see camera-helpers).
    expect(discAnchorFor(3).safeRho).toBeCloseTo(0.85 * R, 6)
    expect(discAnchorFor(4).safeRho).toBeCloseTo(0.85 * Math.PI * R, 6)
    expect(discAnchorFor(5).safeRho).toBeCloseTo(2 * R * Math.tan(0.425 * Math.PI), 6)
  })
})
