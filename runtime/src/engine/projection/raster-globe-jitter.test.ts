import { describe, it, expect } from 'vitest'

// ═══ Raster arm 3 (globe / ECEF) — camera-anchor jitter gate ═══
//
// Companion to the flat-projection pan-jitter gates in coordinate-error-budget
// .test.ts, for the GLOBE arm (projType 7). The globe vs_tile projects each
// vertex to the WGS84 ELLIPSOID ECEF and subtracts the camera anchor, THEN the
// RTC (focus-relative) MVP transforms it. That anchor is the SAME lonLatToECEF
// the globe MVP focuses on (globeForward), so the only precision risk is the
// anchor SUBTRACT — the exact defect #1308 fixed for Mercator.
//
// This gate is the closed form of that subtract, with no GPU: it pans the camera
// a few metres and measures the peak-to-peak SCREEN motion of a stationary globe
// vertex — the literal definition of the shake. It proves TWO things:
//   1. The shipped DSFUN anchor holds the globe raster tile rock-steady
//      (<0.05px at every zoom, both axes) — so a reported globe shake is NOT in
//      the raster tile positions (it would be the camera / interaction path).
//   2. The DSFUN low half is LOAD-BEARING: the pre-#1308 single-f32 anchor shakes
//      >1px at the z20.55 over-zoom (≥100× worse), so a regression that drops the
//      low half re-shakes the globe exactly like every flat projection did.
//
// The ECEF error is ~metric, so |error|·pxPerM is the screen jitter to leading
// order (the RTC MVP is a rotation + small focus-relative translation, so it is
// near-isometric at the tile scale).

const R = 6378137
const DEG2RAD = Math.PI / 180
const TILE_SIZE = 512 // Web-Mercator px tiles (MapLibre parity)
const f = Math.fround
// The shader's truncated f32 constants (proj_globe / ECEF), kept identical so the
// simulation is faithful to the GPU.
const DEG2RAD_F32 = f(0.01745329)
const R_F32 = f(6378137)
const E2 = 0.0066943799901413165 // WGS84 first-eccentricity² (EARTH.e2 / proj_globe EARTH_E2)
const E2_F32 = f(E2)

const pxPerM = (zoom: number): number => (TILE_SIZE * 2 ** zoom) / (2 * Math.PI * R)
function splitF64(x: number): [number, number] {
  const h = f(x)
  return [h, f(x - h)]
}
const VIEW_ZOOMS = [14, 16, 18, 20, 20.55, 22] // includes the reported z20.55 over-zoom

/** f32 ellipsoid ECEF — mirrors the shader lonlat_to_ecef / proj_globe path. */
function ecefEllipsoidF32(lonDeg: number, latDeg: number): [number, number, number] {
  const lam = f(f(lonDeg) * DEG2RAD_F32),
    phi = f(f(latDeg) * DEG2RAD_F32)
  const s = f(Math.sin(phi)),
    c = f(Math.cos(phi))
  const n = f(R_F32 / f(Math.sqrt(f(1 - f(f(E2_F32 * s) * s)))))
  return [
    f(f(n * c) * f(Math.cos(lam))),
    f(f(n * c) * f(Math.sin(lam))),
    f(f(n * f(1 - E2_F32)) * s),
  ]
}
/** f64 ellipsoid ECEF (truth). */
function ecefEllipsoid64(lonDeg: number, latDeg: number): [number, number, number] {
  const lam = lonDeg * DEG2RAD,
    phi = latDeg * DEG2RAD,
    s = Math.sin(phi),
    c = Math.cos(phi)
  const n = R / Math.sqrt(1 - E2 * s * s)
  return [n * c * Math.cos(lam), n * c * Math.sin(lam), n * (1 - E2) * s]
}
/** globe truth: vertex ECEF − camera ECEF (both f64). The camera-relative
 *  position moves SMOOTHLY as the camera pans, so any peak-to-peak in the f32
 *  error over a small pan IS the jitter. */
function globeTruth(
  lon: number,
  lat: number,
  clon: number,
  clat: number,
): [number, number, number] {
  const v = ecefEllipsoid64(lon, lat),
    c = ecefEllipsoid64(clon, clat)
  return [v[0] - c[0], v[1] - c[1], v[2] - c[2]]
}
/** OLD single-f32 anchor (pre-#1308): rel = ecef_f32 − fround(cam), per component. */
function globeOldRel(
  lon: number,
  lat: number,
  clon: number,
  clat: number,
): [number, number, number] {
  const v = ecefEllipsoidF32(lon, lat),
    c = ecefEllipsoid64(clon, clat).map(f)
  return [f(v[0] - c[0]), f(v[1] - c[1]), f(v[2] - c[2])]
}
/** NEW DSFUN anchor: rel = (ecef_f32 − camHi) − camLo, per component. */
function globeNewRel(
  lon: number,
  lat: number,
  clon: number,
  clat: number,
): [number, number, number] {
  const v = ecefEllipsoidF32(lon, lat),
    c = ecefEllipsoid64(clon, clat)
  const h = c.map((x) => splitF64(x)[0]),
    l = c.map((x) => splitF64(x)[1])
  return [f(f(v[0] - h[0]) - l[0]), f(f(v[1] - h[1]) - l[1]), f(f(v[2] - h[2]) - l[2])]
}

type EcefFn = (lon: number, lat: number, clon: number, clat: number) => [number, number, number]
/** Peak-to-peak screen wobble (px) of a stationary globe vertex over a 3 m pan —
 *  worst of the three ECEF components (the RTC MVP is near-isometric at tile scale). */
function panJitterGlobe(
  rel: EcefFn,
  lon: number,
  lat: number,
  clonB: number,
  clatB: number,
  z: number,
  axis: 'lon' | 'lat',
): number {
  const px = pxPerM(z),
    sweepDeg = 3 / (DEG2RAD * R)
  const errs: [number, number, number][] = []
  for (let k = 0; k <= 256; k++) {
    const clon = clonB + (axis === 'lon' ? (sweepDeg * k) / 256 : 0)
    const clat = clatB + (axis === 'lat' ? (sweepDeg * k) / 256 : 0)
    const o = rel(lon, lat, clon, clat),
      t = globeTruth(lon, lat, clon, clat)
    errs.push([o[0] - t[0], o[1] - t[1], o[2] - t[2]])
  }
  let jit = 0
  for (const comp of [0, 1, 2]) {
    let lo = Infinity,
      hi = -Infinity
    for (const e of errs) {
      if (e[comp] < lo) lo = e[comp]
      if (e[comp] > hi) hi = e[comp]
    }
    jit = Math.max(jit, hi - lo)
  }
  return jit * px
}

describe('raster arm 3 (globe / ECEF) — camera-anchor jitter (DSFUN anchor is load-bearing)', () => {
  // Seoul; a vertex ~half a z18 tile from the camera (frame-stable per vertex).
  const clon = 126.9784,
    clat = 37.5665,
    vlon = clon + 0.0007,
    vlat = clat + 0.0005

  it('NEW DSFUN anchor: the globe raster tile is rock-steady (<0.05px) at every zoom, both axes', () => {
    for (const z of VIEW_ZOOMS) {
      for (const axis of ['lon', 'lat'] as const) {
        const jit = panJitterGlobe(globeNewRel, vlon, vlat, clon, clat, z, axis)
        expect(
          jit,
          `globe ${axis}-pan ${jit.toExponential(2)}px @z${z} (must be <0.05px — no shake)`,
        ).toBeLessThan(0.05)
      }
    }
  })

  it('OLD single-f32 anchor: the SAME vertex shakes >1px at the z20.55 over-zoom (the fix is load-bearing)', () => {
    for (const axis of ['lon', 'lat'] as const) {
      const jit = panJitterGlobe(globeOldRel, vlon, vlat, clon, clat, 20.55, axis)
      expect(
        jit,
        `old globe ${axis}-pan ${jit.toFixed(2)}px @z20.55 (must exceed 1px — the visible shake)`,
      ).toBeGreaterThan(1)
    }
  })

  it('DSFUN removes ≥100× of the pan jitter at z20.55, both axes', () => {
    for (const axis of ['lon', 'lat'] as const) {
      const oldJ = panJitterGlobe(globeOldRel, vlon, vlat, clon, clat, 20.55, axis)
      const newJ = panJitterGlobe(globeNewRel, vlon, vlat, clon, clat, 20.55, axis)
      expect(oldJ / Math.max(newJ, 1e-9)).toBeGreaterThan(100)
    }
  })
})
