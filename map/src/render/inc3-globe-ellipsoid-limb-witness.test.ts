// ═══ INC-3 fail-first witness — globe limb + cull sphere→ellipsoid (epic #1152) ═══
//
// Before INC-3 the globe render surface, camera focus, and the whole horizon stack
// (label limb, tile selector, GPU fragment cull) modelled Earth as a SPHERE of
// radius EARTH_R, while the vector/raster VERTEX positions were already on the WGS84
// ELLIPSOID (INC-1/2). That split makes the drawn silhouette (a sphere horizon
// circle) sit OFF the true ellipsoid limb, and the per-anchor / per-tile cull flip
// at a slightly wrong latitude — the "vector↔raster limb mismatch" this increment
// removes. Both witnesses assert the PRODUCTION output now equals an INDEPENDENT
// ellipsoid oracle, and pin the pre-flip sphere-model error (the fail-first RED).
//
// W1 (px) — the projected limb CURVE. The sphere-horizon circle vs the true
//   ellipsoid silhouette, both from the effective eye and through the production RTC
//   mapping (rtcMatrix about the target, focus = the ellipsoid anchor c_ell), differ
//   by a DERIVED max ~1.60 px at clon0/clat60/pitch45/z4/1080×720 (≈1.58 px at
//   clat80/z5/pitch0). Grazing compression collapses the flip-POINT delta to ~0, so
//   the limb-curve-vs-silhouette deviation — not the flip point — is the observable.
//   Production buildGlobeLimbPolygon (now the ellipsoid silhouette) must sit < 0.25 px
//   from the oracle; the sphere model must sit > 1.0 px from it (the removed error).
//
// W2 (boolean) — the cull band. Along the centre meridian the SPHERE cull flips at
//   dot(n̂,E) = a, the exact ELLIPSOID tangent flips at dot(n̂,E) = a·√(1−e2·sin²φ);
//   the gap is a ~0.0056° (~0.6 km) misclassification band. Inside it the sphere and
//   the exact oracle DISAGREE (fail-first), and the production cull
//   (needsBackfaceCullCpu + globeEyeUniform) must now match the EXACT oracle.
//
// GPU-free / analytic (SwiftShader must not judge the limb — §5). The headed real-GPU
// pixel ladder + the Apple/Metal df64 battery are the out-of-environment companions.

import { describe, it, expect } from 'vitest'
import { buildGlobeMatrix, EARTH_R } from '@xgis/geo'
import { EARTH, lonLatToECEF, eyeHorizon } from '@xgis/shared'
import { needsBackfaceCullCpu, globeEyeUniform } from '@xgis/map'
import { buildGlobeLimbPolygon } from '../render-loop-helpers'

const DEG = Math.PI / 180
const A = EARTH_R // WGS84 semi-major (= EARTH.a)
const B = EARTH.b // WGS84 semi-minor
const E2 = EARTH.e2

type V3 = readonly [number, number, number]

/** An orthonormal basis (u, v) ⊥ axis. Same fallback the production limb uses. */
function perp(axis: V3): { u: V3; v: V3 } {
  let ax = 0,
    ay = 0,
    az = 1
  if (Math.abs(axis[2]) > 0.99) {
    ax = 1
    az = 0
  }
  let ux = axis[1] * az - axis[2] * ay,
    uy = axis[2] * ax - axis[0] * az,
    uz = axis[0] * ay - axis[1] * ax
  const ul = Math.hypot(ux, uy, uz) || 1
  ux /= ul
  uy /= ul
  uz /= ul
  const vx = axis[1] * uz - axis[2] * uy,
    vy = axis[2] * ux - axis[0] * uz,
    vz = axis[0] * uy - axis[1] * ux
  return { u: [ux, uy, uz], v: [vx, vy, vz] }
}

/** Project an absolute-ECEF ring point through the production RTC mapping
 *  (focus-subtract → mvp → NDC → screen px). Returns null when behind the camera. */
function projectRTC(
  p: V3,
  mvp: Float32Array,
  focus: V3,
  w: number,
  h: number,
): [number, number] | null {
  const rx = p[0] - focus[0],
    ry = p[1] - focus[1],
    rz = p[2] - focus[2]
  const cw = mvp[3]! * rx + mvp[7]! * ry + mvp[11]! * rz + mvp[15]!
  if (cw <= 0) return null
  const ndcX = (mvp[0]! * rx + mvp[4]! * ry + mvp[8]! * rz + mvp[12]!) / cw
  const ndcY = (mvp[1]! * rx + mvp[5]! * ry + mvp[9]! * rz + mvp[13]!) / cw
  return [(ndcX + 1) * 0.5 * w, (1 - ndcY) * 0.5 * h]
}

/** Independent ellipsoid silhouette from eye E: scale to the UNIT sphere (x/a, y/a,
 *  z/b), take that sphere's horizon ring, then UNSCALE by (a, a, b). A different
 *  arithmetic framing from production (which z-stretches to radius a), so agreement
 *  validates the geometry, not the implementation. */
function ellipsoidLimbScreen(E: V3, mvp: Float32Array, focus: V3, w: number, h: number, k = 512) {
  const qE: V3 = [E[0] / A, E[1] / A, E[2] / B]
  const ql = Math.hypot(qE[0], qE[1], qE[2])
  const qn: V3 = [qE[0] / ql, qE[1] / ql, qE[2] / ql]
  const cosH = 1 / ql
  const sinH = Math.sqrt(Math.max(0, 1 - cosH * cosH))
  const { u, v } = perp(qn)
  const pts: [number, number][] = []
  for (let i = 0; i < k; i++) {
    const t = (i / k) * Math.PI * 2
    const ct = Math.cos(t),
      st = Math.sin(t)
    // unit-sphere ring, then unscale to ellipsoid ECEF (x·a, y·a, z·b)
    const P: V3 = [
      (qn[0] * cosH + sinH * (u[0] * ct + v[0] * st)) * A,
      (qn[1] * cosH + sinH * (u[1] * ct + v[1] * st)) * A,
      (qn[2] * cosH + sinH * (u[2] * ct + v[2] * st)) * B,
    ]
    const s = projectRTC(P, mvp, focus, w, h)
    if (s) pts.push(s)
  }
  return pts
}

/** The retired SPHERE-model limb (radius a, no z-unscale) from eye E — what the
 *  pre-INC-3 code drew. Used to pin the fail-first error magnitude. */
function sphereLimbScreen(E: V3, mvp: Float32Array, focus: V3, w: number, h: number, k = 512) {
  const el = Math.hypot(E[0], E[1], E[2])
  const en: V3 = [E[0] / el, E[1] / el, E[2] / el]
  const cosH = A / el
  const sinH = Math.sqrt(Math.max(0, 1 - cosH * cosH))
  const { u, v } = perp(en)
  const pts: [number, number][] = []
  for (let i = 0; i < k; i++) {
    const t = (i / k) * Math.PI * 2
    const ct = Math.cos(t),
      st = Math.sin(t)
    const P: V3 = [
      en[0] * (A * cosH) + A * sinH * (u[0] * ct + v[0] * st),
      en[1] * (A * cosH) + A * sinH * (u[1] * ct + v[1] * st),
      en[2] * (A * cosH) + A * sinH * (u[2] * ct + v[2] * st),
    ]
    const s = projectRTC(P, mvp, focus, w, h)
    if (s) pts.push(s)
  }
  return pts
}

/** One-sided max screen deviation: for each point of A, the min distance to the
 *  closed polyline B. Robust to differing parameterisation (radial gap upper bound). */
function maxDeviationPx(as: [number, number][], bs: [number, number][]): number {
  if (as.length === 0 || bs.length < 2) return Infinity
  let worst = 0
  for (const p of as) {
    let best = Infinity
    for (let j = 0, i = bs.length - 1; j < bs.length; i = j++) {
      const xi = bs[i]![0],
        yi = bs[i]![1],
        xj = bs[j]![0],
        yj = bs[j]![1]
      const dx = xj - xi,
        dy = yj - yi
      const seg = dx * dx + dy * dy
      let t = seg > 0 ? ((p[0] - xi) * dx + (p[1] - yi) * dy) / seg : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const cx = xi + t * dx,
        cy = yi + t * dy
      const d = Math.hypot(p[0] - cx, p[1] - cy)
      if (d < best) best = d
    }
    if (best > worst) worst = best
  }
  return worst
}

/** W1 for one camera. Returns { sphereVsOracle, prodVsOracle }. */
function w1(clon: number, clat: number, zoom: number, pitch: number, w: number, h: number) {
  const view = buildGlobeMatrix(clon, clat, zoom, pitch, 0, w, h)
  const cEll = lonLatToECEF(clon, clat) as unknown as V3 // production ellipsoid anchor c_ell
  // Effective eye in the ellipsoid-anchored frame the RTC mapping renders about.
  const eEff: V3 = [
    cEll[0] + view.eye[0] - view.target[0],
    cEll[1] + view.eye[1] - view.target[1],
    cEll[2] + view.eye[2] - view.target[2],
  ]
  const oracle = ellipsoidLimbScreen(eEff, view.rtcMatrix, cEll, w, h)
  const sphere = sphereLimbScreen(eEff, view.rtcMatrix, cEll, w, h)
  // Production limb (now the ellipsoid silhouette) via the same mapping. The label
  // pass feeds the SHARED eyeHorizon(eye,a,b) — reproduce it here.
  const prodPoly = buildGlobeLimbPolygon(view.rtcMatrix, w, h, eyeHorizon(view.eye, A, B), cEll)
  expect(prodPoly, 'production limb polygon degenerate at witness camera').not.toBeNull()
  const prod: [number, number][] = []
  for (let i = 0; i < prodPoly!.n; i++) prod.push([prodPoly!.xs[i]!, prodPoly!.ys[i]!])
  return {
    sphereVsOracle: maxDeviationPx(sphere, oracle),
    prodVsOracle: maxDeviationPx(prod, oracle),
  }
}

describe('INC-3 W1 — projected globe limb curve is the ELLIPSOID silhouette', () => {
  it('clat60/z4/pitch45: production limb matches the ellipsoid oracle (<0.25px); sphere model is off (>1px)', () => {
    // DERIVATION (THRESHOLD_PX pattern): the sphere-of-radius-a horizon circle and
    // the WGS84 silhouette from the same effective eye, both through the production
    // RTC mapping, deviate at this camera — MEASURED one-sided max 2.76 px (mean
    // 1.10 px) as the max distance from each sphere-ring point to the ellipsoid-limb
    // polyline. That is the limb error INC-3 removes. Post-flip the production limb IS
    // the silhouette, so it sits sub-0.25 px (~1e-9 px, arithmetic-only) from the
    // independent oracle. RED pre-flip (production drew the sphere circle → 2.76 px);
    // GREEN post-flip. (The epic brief cited ~1.60 px from a pure-radial metric; this
    // Hausdorff-to-polyline reads a larger max but the same > 1 px vs < 0.25 px split.)
    const { sphereVsOracle, prodVsOracle } = w1(0, 60, 4, 45, 1080, 720)
    expect(sphereVsOracle).toBeGreaterThan(1.0) // fail-first: the sphere model IS off
    expect(prodVsOracle).toBeLessThan(0.25) // fixed: production is the ellipsoid limb
  })

  it('clat80/z5/pitch0: second witness cell (sphere off ~4.90px; production matches)', () => {
    const { sphereVsOracle, prodVsOracle } = w1(0, 80, 5, 0, 1080, 720)
    expect(sphereVsOracle).toBeGreaterThan(1.0)
    expect(prodVsOracle).toBeLessThan(0.25)
  })
})

// ── W2 — the cull misclassification band ──
const geodeticNormal = (lonDeg: number, latDeg: number): V3 => {
  const lam = lonDeg * DEG,
    phi = latDeg * DEG,
    c = Math.cos(phi)
  return [c * Math.cos(lam), c * Math.sin(lam), Math.sin(phi)]
}
const dot = (p: V3, q: V3): number => p[0] * q[0] + p[1] * q[1] + p[2] * q[2]
/** Exact ellipsoid tangent-plane cull signal (>0 visible): dot(n̂,E) − a·√(1−e2·sin²φ). */
const oracleSignal = (lon: number, lat: number, eye: V3): number => {
  const s = Math.sin(lat * DEG)
  return dot(geodeticNormal(lon, lat), eye) - A * Math.sqrt(1 - E2 * s * s)
}
/** Retired sphere cull signal (>0 visible): dot(n̂,E) − a. */
const sphereSignal = (lon: number, lat: number, eye: V3): number =>
  dot(geodeticNormal(lon, lat), eye) - A

/** Binary-search the meridian latitude where `sig` crosses 0. `lo`/`hi` must bracket
 *  the (single) horizon crossing with opposite signs; the eye's high altitude puts
 *  the lon=0 crossing on the SOUTH side (the sub-eye point is ~lat 40 here, horizon
 *  radius ~54°, so the north crossing wraps past the pole onto lon 180). */
function flipLat(sig: (lat: number) => number, lo: number, hi: number): number {
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (sig(lo) > 0 === sig(mid) > 0) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

describe('INC-3 W2 — meridian cull band matches the exact ellipsoid tangent oracle', () => {
  it('clat60/z4/pitch45: production cull equals the exact tangent oracle inside the sphere/ellipsoid band', () => {
    const clon = 0,
      clat = 60
    const view = buildGlobeMatrix(clon, clat, 4, 45, 0, 1080, 720)
    const eye = view.eye as unknown as V3
    const ge = globeEyeUniform(view.eye) as [number, number, number, number]

    // South-side horizon crossing (sig(clat) > 0 near-view, sig(−85) < 0 past horizon).
    const sphereFlip = flipLat((lat) => sphereSignal(clon, lat, eye), -85, clat)
    const oracleFlip = flipLat((lat) => oracleSignal(clon, lat, eye), -85, clat)
    // The misclassification band is real and sub-tile — MEASURED 0.0084° (~931 m) at
    // the lon=0 south crossing (lat ≈ −14.1°): fail-first. (The brief cited 0.0056° at
    // a north sample; the eye's ~54° horizon radius puts the lon=0 crossing on the
    // south side here — same class of sub-tile band either way.)
    const bandDeg = Math.abs(sphereFlip - oracleFlip)
    expect(bandDeg).toBeGreaterThan(0.003)
    expect(bandDeg).toBeLessThan(0.05)

    // A sample mid-band: the sphere model and the exact oracle DISAGREE there.
    const bandLat = (sphereFlip + oracleFlip) / 2
    expect(sphereSignal(clon, bandLat, eye) > 0).not.toBe(oracleSignal(clon, bandLat, eye) > 0)

    // Production (globe_eye_horizon_cos via the CPU mirror) must match the EXACT
    // oracle across the band — RED pre-flip (production was the sphere model), GREEN
    // now. Sample finely so a boundary sliver cannot make it vacuous.
    for (let f = -0.4; f <= 0.4 + 1e-9; f += 0.2) {
      const lat = bandLat + f * bandDeg
      const prodVisible = needsBackfaceCullCpu(7, clon, lat, clon, clat, ge) > 0
      expect(prodVisible, `production cull disagrees with the tangent oracle at lat ${lat}`).toBe(
        oracleSignal(clon, lat, eye) > 0,
      )
    }
  })
})
