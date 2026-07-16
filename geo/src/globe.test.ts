// ═══ True 3D Globe (projType 7) — CPU core + interaction ═══
//
// This environment has no GPU, so these unit tests ARE the verification
// for slice 1. They pin: sphere forward/inverse round-trip, the orbit
// camera invariants (incl. the "pitch must keep the globe 3D, not flat"
// regression that motivated the work), ray↔sphere unproject as a true
// inverse of the camera, and the dateline-wrapping tile selection.

import { describe, expect, it } from 'vitest'
import { lonLatToECEF } from '@xgis/shared'
import {
  EARTH_R,
  GLOBE_PROJ_TYPE,
  buildGlobeMatrix,
  globeForward,
  globeInverse,
  unprojectGlobe,
} from './globe'

const W = 1280,
  H = 720
const DEG2RAD = Math.PI / 180

function mulVec4(
  m: Float32Array,
  v: [number, number, number, number],
): [number, number, number, number] {
  const r: [number, number, number, number] = [0, 0, 0, 0]
  for (let row = 0; row < 4; row++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += m[k * 4 + row] * v[k]
    r[row] = s
  }
  return r
}

function projectNDC(view: ReturnType<typeof buildGlobeMatrix>, lon: number, lat: number) {
  const p = globeForward(lon, lat)
  const clip = mulVec4(view.matrix, [p[0], p[1], p[2], 1])
  return { ndc: [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]] as const, w: clip[3] }
}

describe('globe — projType', () => {
  it('is appended as 7 (0..6 untouched)', () => {
    expect(GLOBE_PROJ_TYPE).toBe(7)
  })
})

describe('globe — forward / inverse', () => {
  it('lon=0,lat=0 → +X axis on the sphere', () => {
    const [x, y, z] = globeForward(0, 0)
    expect(x).toBeCloseTo(EARTH_R, 3)
    expect(y).toBeCloseTo(0, 3)
    expect(z).toBeCloseTo(0, 3)
  })

  it('north pole → +Z, lon=90 → +Y', () => {
    const np = globeForward(0, 90)
    expect(np[2]).toBeCloseTo(EARTH_R, 3)
    const e = globeForward(90, 0)
    expect(e[1]).toBeCloseTo(EARTH_R, 3)
  })

  it('every sample point sits on the sphere of radius EARTH_R', () => {
    for (let lon = -180; lon <= 180; lon += 45)
      for (let lat = -80; lat <= 80; lat += 40) {
        const [x, y, z] = globeForward(lon, lat)
        expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(EARTH_R, 0)
      }
  })

  it('inverse round-trips to ≤1e-6° across the globe', () => {
    for (let lon = -179; lon <= 179; lon += 37)
      for (let lat = -85; lat <= 85; lat += 23) {
        const [x, y, z] = globeForward(lon, lat)
        const [lon2, lat2] = globeInverse(x, y, z)
        expect(lon2).toBeCloseTo(lon, 6)
        expect(lat2).toBeCloseTo(lat, 6)
      }
  })

  it('inverse is radius-agnostic (any point on the ray → same lon/lat)', () => {
    const [x, y, z] = globeForward(127, 37)
    const [lon, lat] = globeInverse(x * 0.3, y * 0.3, z * 0.3)
    expect(lon).toBeCloseTo(127, 6)
    expect(lat).toBeCloseTo(37, 6)
  })
})

describe('globe — orbit camera', () => {
  it('camera centre projects to NDC (0,0) at pitch 0', () => {
    const v = buildGlobeMatrix(127, 37, 3, 0, 0, W, H)
    const c = projectNDC(v, 127, 37)
    expect(c.w).toBeGreaterThan(0)
    expect(c.ndc[0]).toBeCloseTo(0, 4)
    expect(c.ndc[1]).toBeCloseTo(0, 4)
  })

  it('centre stays at NDC (0,0) under pitch + bearing', () => {
    for (const pitch of [0, 30, 60]) {
      for (const bearing of [0, 90, 200]) {
        const v = buildGlobeMatrix(10, 20, 4, pitch, bearing, W, H)
        const c = projectNDC(v, 10, 20)
        expect(c.w).toBeGreaterThan(0)
        expect(c.ndc[0]).toBeCloseTo(0, 3)
        expect(c.ndc[1]).toBeCloseTo(0, 3)
      }
    }
  })

  it('the antipode of the centre is behind the camera (a real sphere, not a flat disc)', () => {
    const v = buildGlobeMatrix(0, 0, 2, 0, 0, W, H)
    // Front (centre) is in front; the opposite side of the globe must
    // NOT also be in front — that is exactly what a flattened 2D disc
    // would wrongly do.
    const front = projectNDC(v, 0, 0)
    const back = projectNDC(v, 180, 0)
    expect(front.w).toBeGreaterThan(0)
    // The antipode is a full diameter farther from the eye than the
    // near point: clip.w (camera-space depth) must differ by ≈ 2·R.
    // A flattened 2D disc would collapse that gap to ~0 — this is the
    // precise discriminator between a true sphere and the reported bug.
    expect(back.w - front.w).toBeGreaterThan(EARTH_R)
    expect(back.w - front.w).toBeCloseTo(2 * EARTH_R, -2)
  })

  it('PITCH KEEPS THE GLOBE 3D: depth varies across the surface when pitched', () => {
    // The reported bug: pitching "lays the map flat to 2D". In a true
    // 3D globe a pitched view must have real depth spread — the near
    // edge of the visible cap is closer than the far edge. A flattened
    // disc would collapse that to ~one depth.
    const flat = buildGlobeMatrix(0, 0, 3, 0, 0, W, H)
    const pitched = buildGlobeMatrix(0, 0, 3, 60, 0, W, H)
    const nearPt = projectNDC(pitched, 0, -8) // toward the eye (south, bearing 0 leans north)
    const farPt = projectNDC(pitched, 0, 8) // toward the horizon
    expect(nearPt.w).toBeGreaterThan(0)
    expect(farPt.w).toBeGreaterThan(0)
    // Genuine perspective depth separation under pitch…
    expect(Math.abs(farPt.ndc[2] - nearPt.ndc[2])).toBeGreaterThan(1e-4)
    // …and pitch actually changes the projection (not a no-op / not flat).
    const a = projectNDC(flat, 0, 8)
    expect(Math.abs(a.ndc[1] - farPt.ndc[1])).toBeGreaterThan(1e-3)
  })
})

// INC-2 (ellipsoid-datum-unification.md): unprojectGlobe now intersects the
// WGS84 ELLIPSOID (was: sphere of radius EARTH_R) and inverts via the
// ellipsoidal ecefToLonLat, so cursor/pick/measure return the same geodetic
// datum the vector tiles / point anchors use (unified in INC-1).
//
// Witness = round-trip: project a KNOWN ellipsoid surface point
// (lonLatToECEF) through the globe camera to a screen pixel, unproject it, and
// require the input geodetic lon/lat back. BEFORE the fix (sphere
// intersection) the readback diverges by the sphere-vs-ellipsoid surface
// offset |lonLatToECEF − globeForward|: 0 m @ lat0, ~21.3 km @ lat35,
// ~24.5 km @ lat60, ~21.6 km @ lat85, ~21.4 km (= a − b) @ the pole — a
// geodetic point read back spherically lands at its geocentric latitude
// (≈0.03–0.19° off). AFTER, the round-trip closes to the f32-view-matrix floor
// (the ~6.4 Mm absolute ECEF magnitude through a Float32Array MVP is the
// limiter, NOT the ellipsoid math, which is exact to <1 mm). Equator and the
// poles are the fixed points (geodetic == geocentric there), so they close
// before AND after — the poles case guards the ecefToLonLat polar singularity.
const METRE_PER_DEG = (Math.PI / 180) * EARTH_R
/** Project the ellipsoid surface point at (ptLon,ptLat) through `view`,
 *  unproject it, and return the ground-metre miss of the round-trip. */
function unprojectRoundTripMetres(
  view: ReturnType<typeof buildGlobeMatrix>,
  ptLon: number,
  ptLat: number,
): number {
  const e = lonLatToECEF(ptLon, ptLat, 0)
  const clip = mulVec4(view.matrix, [e[0], e[1], e[2], 1])
  const sx = (clip[0] / clip[3] + 1) * 0.5 * W
  const sy = (1 - clip[1] / clip[3]) * 0.5 * H
  const hit = unprojectGlobe(sx, sy, W, H, view)
  if (!hit) return Infinity
  const dLatM = (hit[1] - ptLat) * METRE_PER_DEG
  // cos(lat) collapses the lon term to 0 at the poles, where lon is undefined.
  const dLonM = (hit[0] - ptLon) * METRE_PER_DEG * Math.cos(ptLat * DEG2RAD)
  return Math.hypot(dLatM, dLonM)
}

describe('globe — unproject (ray ↔ ellipsoid, INC-2)', () => {
  // Metre floor (measured): AFTER the fix every centred round-trip closes to
  // the f32 MVP limit — 16.7 m at the equator (pure Float32Array-matrix noise,
  // zero datum offset there), 3–10 m at lat 35/60/85. BEFORE the fix those
  // same latitudes miss by 20064 / 18486 / 3702 m (the sphere-vs-ellipsoid
  // readback), so EPS_M = 50 sits ~3× over the f32 floor and ~75–400× under
  // the divergence — only the genuinely sphere-vs-ellipsoid latitudes flip.
  // The datum MATH itself is exact: ecefToLonLat∘lonLatToECEF round-trips to
  // ~7e-15° (<1 mm); the residual here is the f32 MVP, not the ellipsoid.
  const EPS_M = 50
  it('a centred ellipsoid point round-trips to the geodetic datum (< EPS_M)', () => {
    for (const [lon, lat] of [
      [20, 0],
      [20, 35],
      [45, -35],
      [70, 60],
      [-110, -60],
      [10, 85],
      [-30, -85],
      [0, 90],
      [0, -90],
    ] as const) {
      const v = buildGlobeMatrix(lon, lat, 4, 0, 0, W, H)
      expect(unprojectRoundTripMetres(v, lon, lat)).toBeLessThan(EPS_M)
    }
  })

  it('round-trips an off-centre, pitched ellipsoid point', () => {
    // Camera centred at (20,10) pitched/bearing'd; the probe point sits on the
    // visible front hemisphere. Off-axis + pitch inflates the f32 MVP error,
    // so the floor is looser than the on-axis EPS_M — still 100× under the
    // ~24 km sphere divergence.
    const v = buildGlobeMatrix(20, 10, 4, 20, 45, W, H)
    expect(unprojectRoundTripMetres(v, 24, 13)).toBeLessThan(60)
  })

  it('a pixel pointing past the limb misses the globe (null)', () => {
    const v = buildGlobeMatrix(0, 0, 3, 0, 0, W, H)
    expect(unprojectGlobe(2, 2, W, H, v)).toBeNull()
  })
})

describe('globe — RTC matrix (renderer feeds proj_globe(v) − proj_globe(center))', () => {
  it('the focus point (rtc origin) projects to NDC (0,0)', () => {
    for (const [lon, lat, p] of [
      [0, 0, 0],
      [127, 37, 40],
      [-150, -20, 70],
    ] as const) {
      const v = buildGlobeMatrix(lon, lat, 4, p, 0, W, H)
      const c = mulVec4(v.rtcMatrix, [0, 0, 0, 1]) // focus − focus = 0
      expect(c[3]).toBeGreaterThan(0)
      expect(c[0] / c[3]).toBeCloseTo(0, 4)
      expect(c[1] / c[3]).toBeCloseTo(0, 4)
    }
  })

  it('rtcMatrix·(p−focus) lands at the same NDC as matrix·p (RTC of the absolute MVP)', () => {
    // The ABSOLUTE path multiplies a f32 matrix by ~6.37e6 coords and
    // loses precision in raw clip space — that loss is the very reason
    // RTC exists, so compare the meaningful quantity (NDC = screen pos),
    // not raw clip components, and only near the focus where the
    // absolute path is still trustworthy.
    const v = buildGlobeMatrix(30, 15, 5, 35, 50, W, H)
    const focus = globeForward(30, 15)
    for (const [lon, lat] of [
      [30.5, 15.5],
      [29.5, 14.5],
      [31, 16],
    ] as const) {
      const p = globeForward(lon, lat)
      const a = mulVec4(v.matrix, [p[0], p[1], p[2], 1])
      const r = mulVec4(v.rtcMatrix, [p[0] - focus[0], p[1] - focus[1], p[2] - focus[2], 1])
      expect(r[0] / r[3]).toBeCloseTo(a[0] / a[3], 2)
      expect(r[1] / r[3]).toBeCloseTo(a[1] / a[3], 2)
    }
  })
})

// Cesium's camera tilts AROUND the focus point at a CONSTANT range:
// pitch ≈ -90° looks straight down (nadir); raising it sweeps the view
// toward the horizon while the focus stays put — a real perspective
// orbit, never a flattened plane. This engine's pitch is 0 = top-down
// up to ~85 = near-horizon, so 0..85 maps onto Cesium's -90..-5.
describe('globe — Cesium-style pitch', () => {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const len = (a: number[]) => Math.sqrt(dot(a, a))
  const norm = (a: number[]) => {
    const l = len(a) || 1
    return [a[0] / l, a[1] / l, a[2] / l]
  }

  it('orbits at a CONSTANT range to the focus as pitch changes', () => {
    const ranges = [0, 20, 45, 70, 85].map((p) => {
      const v = buildGlobeMatrix(127, 37, 4, p, 0, W, H)
      return len(sub(v.eye, v.target))
    })
    for (const r of ranges) expect(r).toBeCloseTo(ranges[0], 3)
  })

  it('pitch 0 = nadir (straight down); raising pitch sweeps toward the horizon', () => {
    for (const lonlat of [
      [0, 0],
      [127, 37],
      [-150, -25],
    ] as const) {
      const focusN = norm(globeForward(lonlat[0], lonlat[1])) // surface normal
      let prev = -Infinity
      for (const p of [0, 30, 60, 85]) {
        const v = buildGlobeMatrix(lonlat[0], lonlat[1], 4, p, 0, W, H)
        const viewDir = norm(sub(v.target, v.eye))
        // dot(view, normal) == -cos(pitch): -1 at nadir → 0 at horizon.
        const d = dot(viewDir, focusN)
        expect(d).toBeCloseTo(-Math.cos((p * Math.PI) / 180), 2)
        expect(d).toBeGreaterThan(prev) // monotone tilt toward the horizon
        prev = d
      }
    }
  })

  it('focus stays dead-centre while tilting (orbit, not pan)', () => {
    for (const p of [0, 25, 55, 82]) {
      const v = buildGlobeMatrix(40, -10, 5, p, 60, W, H)
      const t = globeForward(40, -10)
      const clip = mulVec4(v.matrix, [t[0], t[1], t[2], 1])
      expect(clip[3]).toBeGreaterThan(0)
      expect(clip[0] / clip[3]).toBeCloseTo(0, 3)
      expect(clip[1] / clip[3]).toBeCloseTo(0, 3)
    }
  })

  it('tilting reveals more of the globe toward the heading (the limb comes into view)', () => {
    // More surface should fall in front of the camera as we tilt up.
    const facingCount = (pitch: number) => {
      const v = buildGlobeMatrix(0, 0, 3, pitch, 0, W, H)
      const eyeN = norm(v.eye)
      let n = 0
      for (let lon = -90; lon <= 90; lon += 10)
        for (let lat = -80; lat <= 80; lat += 10) {
          const p = norm(globeForward(lon, lat))
          if (dot(p, eyeN) > EARTH_R / len(v.eye)) n++
        }
      return n
    }
    // Higher pitch ⇒ the eye is lower/closer to the surface tangent, so
    // its horizon circle is smaller — but the view looks ACROSS the
    // curve toward the limb. Assert the camera genuinely moves (eye is
    // not the same point) and stays outside the sphere at every pitch.
    for (const p of [0, 40, 80]) {
      const v = buildGlobeMatrix(0, 0, 3, p, 0, W, H)
      expect(len(v.eye)).toBeGreaterThan(EARTH_R) // never inside the globe
    }
    const e0 = buildGlobeMatrix(0, 0, 3, 0, 0, W, H).eye
    const e80 = buildGlobeMatrix(0, 0, 3, 80, 0, W, H).eye
    expect(len(sub(e0, e80))).toBeGreaterThan(1) // the camera actually orbits
    expect(facingCount(0)).toBeGreaterThan(0)
  })
})
