// ═══ Globe telephoto-orbit camera — flat-2D orthographic parity ═══
//
// Relocated from engine's globe.test.ts in #781 (3b): this describe builds a
// Camera (now @xgis/map) to verify the globe telephoto matrix, so it lives with
// the Camera cluster. buildGlobeMatrix / globeForward / EARTH_R come from the geo
// primitives still resident in @xgis/engine (→ @xgis/geo in 3c).

import { describe, expect, it } from 'vitest'
import { EARTH_R, buildGlobeMatrix, globeForward } from '@xgis/geo'

const W = 1280,
  H = 720

// The azimuthal set (orthographic / azimuthal_equidistant / stereographic)
// promotes to this sphere path when tilted. The `ortho` flag makes it a
// TELEPHOTO orbit camera: visually near-parallel (matches the flat 2D
// orthographic framing) yet it keeps a varying clip.w so the shared
// log-depth buffer still occludes the far hemisphere — a true parallel
// matrix (clip.w≡1) collapses log-depth and the back renders through.
describe('globe — orthographic (telephoto) orbit camera', () => {
  const d2r = Math.PI / 180
  const projOrtho = (lon: number, lat: number, clon: number, clat: number) => {
    const lam = lon * d2r,
      phi = lat * d2r,
      l0 = clon * d2r,
      p0 = clat * d2r
    return [
      EARTH_R * Math.cos(phi) * Math.sin(lam - l0),
      EARTH_R * (Math.cos(p0) * Math.sin(phi) - Math.sin(p0) * Math.cos(phi) * Math.cos(lam - l0)),
    ]
  }
  const ndc = (m: ArrayLike<number>, v: number[]) => {
    const w = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3]
    return [
      (m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3]) / w,
      (m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3]) / w,
    ]
  }

  it('pitch=0 telephoto-globe ≈ flat 2D orthographic, far closer than perspective', async () => {
    const { Camera } = await import('./camera')
    const clon = 10,
      clat = 30,
      zoom = 2
    const cam = new Camera(clon, clat, zoom)
    cam.projType = 3 // flat 2D azimuthal path
    const m2d = cam.getRTCMatrix(W, H, 1)
    const tele = buildGlobeMatrix(clon, clat, zoom, 0, 0, W, H, true) // ortho/telephoto
    const persp = buildGlobeMatrix(clon, clat, zoom, 0, 0, W, H, false) // plain perspective
    const fc = globeForward(clon, clat)
    for (const [lon, lat] of [
      [10, 30],
      [15, 35],
      [5, 25],
      [30, 10],
      [-10, 50],
      [40, -5],
    ]) {
      const a = ndc(m2d, [...projOrtho(lon, lat, clon, clat), 0, 1])
      const g = globeForward(lon, lat)
      const rel = [g[0] - fc[0], g[1] - fc[1], g[2] - fc[2], 1]
      const t = ndc(tele.rtcMatrix, rel)
      const p = ndc(persp.rtcMatrix, rel)
      const eTele = Math.hypot(a[0] - t[0], a[1] - t[1])
      const ePersp = Math.hypot(a[0] - p[0], a[1] - p[1])
      // Telephoto is visually parallel: close to the exact 2D ortho …
      expect(eTele).toBeLessThan(0.02)
      // … and dramatically closer than a full perspective globe would be
      // (skip the centre point where both are exactly 0).
      if (ePersp > 1e-6) expect(eTele).toBeLessThan(ePersp * 0.2)
    }
  })

  it('clip.w varies with depth (log-depth occludes the far hemisphere) + tilts', () => {
    const fc = globeForward(0, 0)
    const rel = (lon: number, lat: number) => {
      const g = globeForward(lon, lat)
      return [g[0] - fc[0], g[1] - fc[1], g[2] - fc[2], 1]
    }
    const flat = buildGlobeMatrix(0, 0, 2, 0, 0, W, H, true)
    const tilt = buildGlobeMatrix(0, 0, 2, 45, 0, W, H, true)
    const clipW = (m: ArrayLike<number>, p: number[]) =>
      m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15] * p[3]
    // Near hemisphere (front, by the focus) vs far hemisphere (behind the
    // globe). A real parallel matrix gives w≡1 for both → constant depth
    // → back renders through. The telephoto camera MUST separate them.
    const wFront = clipW(tilt.rtcMatrix, rel(0, 0))
    const wBack = clipW(tilt.rtcMatrix, rel(180, 0))
    expect(wFront).toBeGreaterThan(0)
    expect(wBack - wFront).toBeGreaterThan(EARTH_R) // clearly ordered in depth
    // Tilting still moves an off-centre point vertically on screen.
    expect(
      Math.abs(ndc(tilt.rtcMatrix, rel(0, 10))[1] - ndc(flat.rtcMatrix, rel(0, 10))[1]),
    ).toBeGreaterThan(0.05)
  })
})
