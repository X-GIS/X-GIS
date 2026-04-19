// ═══ WGSL Projection Mirror (Phase 2-A) ═══
//
// TypeScript mirrors of the WGSL proj_* functions in renderer.ts and
// raster-renderer.ts. The runtime does GPU projection via WGSL; tile
// selection and bounds math do CPU projection via projection.ts. CLAUDE.md
// mandates keeping the two in sync, but there was no automated check,
// and 2026-04 recon found multiple divergences (Mercator clamp, Natural
// Earth formula, ortho back-face handling).
//
// Each mirror implements the EXACT math of the WGSL block (line-for-line).
// Tests compare the mirror against the canonical CPU implementation in
// projection.ts. A divergence surfaces as a test failure, not a user
// report six months later.
//
// When the WGSL shader changes, the matching mirror MUST update in the
// same commit. The consistency test will fail otherwise.

const EARTH_R = 6378137
const DEG2RAD = Math.PI / 180

/** Mirror of `fn proj_mercator` in renderer.ts:55 and raster-renderer.ts:24. */
export function projMercatorWgsl(lon: number, lat: number): [number, number] {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat))
  const x = lon * DEG2RAD * EARTH_R
  const y = Math.log(Math.tan(Math.PI / 4 + (clamped * DEG2RAD) / 2)) * EARTH_R
  return [x, y]
}

/** Mirror of `fn proj_natural_earth` in renderer.ts and raster-renderer.ts:36.
 *  Uses the Šavrič et al. (2015) 6th-order polynomial — NOT the table-based
 *  interpolation in projection.ts `naturalEarth.forward`. The divergence is
 *  real and intentional on the GPU side for shader-friendly evaluation. */
export function projNaturalEarthWgsl(lon: number, lat: number): [number, number] {
  const latR = lat * DEG2RAD
  const lat2 = latR * latR
  const lat4 = lat2 * lat2
  const lat6 = lat2 * lat4
  const xScale = 0.8707 - 0.131979 * lat2 + 0.013791 * lat4 - 0.0081435 * lat6
  const yVal = latR * (1.007226 + lat2 * (0.015085 + lat2 * (-0.044475 + 0.028874 * lat2 - 0.005916 * lat4)))
  return [lon * DEG2RAD * xScale * EARTH_R, yVal * EARTH_R]
}

/** Mirror of `fn proj_equirectangular` in raster-renderer.ts:32. */
export function projEquirectangularWgsl(lon: number, lat: number): [number, number] {
  return [lon * DEG2RAD * EARTH_R, lat * DEG2RAD * EARTH_R]
}

/** Mirror of `fn proj_orthographic` in raster-renderer.ts:46.
 *  NOTE: Unlike CPU `orthographic.forward` which returns [NaN, NaN] for
 *  back-hemisphere points, the WGSL function computes coords regardless.
 *  Back-face culling in renderer.ts is a SEPARATE `needs_backface_cull`
 *  function — so this mirror also returns valid coords for cosC < 0.
 *  Consumers that need culling must check cosC themselves. */
export function projOrthographicWgsl(lon: number, lat: number, clon: number, clat: number): [number, number] {
  const lam = lon * DEG2RAD, phi = lat * DEG2RAD
  const l0 = clon * DEG2RAD, p0 = clat * DEG2RAD
  return [
    EARTH_R * Math.cos(phi) * Math.sin(lam - l0),
    EARTH_R * (Math.cos(p0) * Math.sin(phi) - Math.sin(p0) * Math.cos(phi) * Math.cos(lam - l0)),
  ]
}

/** cos(c) helper (center angular distance) matching `center_cos_c` in both
 *  WGSL shaders. Use this to detect back-hemisphere points in Ortho. */
export function cosC(lon: number, lat: number, clon: number, clat: number): number {
  const lam = lon * DEG2RAD, phi = lat * DEG2RAD
  const l0 = clon * DEG2RAD, p0 = clat * DEG2RAD
  return Math.sin(p0) * Math.sin(phi) + Math.cos(p0) * Math.cos(phi) * Math.cos(lam - l0)
}

/** Mirror of `fn proj_azimuthal_equidistant` in raster-renderer.ts:55. */
export function projAzimuthalEquidistantWgsl(lon: number, lat: number, clon: number, clat: number): [number, number] {
  const lam = lon * DEG2RAD, phi = lat * DEG2RAD
  const l0 = clon * DEG2RAD, p0 = clat * DEG2RAD
  const cc = Math.sin(p0) * Math.sin(phi) + Math.cos(p0) * Math.cos(phi) * Math.cos(lam - l0)
  const c = Math.acos(Math.max(-1, Math.min(1, cc)))
  if (c < 0.0001) return [0, 0]
  const k = c / Math.sin(c)
  return [
    EARTH_R * k * Math.cos(phi) * Math.sin(lam - l0),
    EARTH_R * k * (Math.cos(p0) * Math.sin(phi) - Math.sin(p0) * Math.cos(phi) * Math.cos(lam - l0)),
  ]
}

/** Mirror of `fn proj_stereographic` in raster-renderer.ts:65.
 *  Returns a sentinel far-off point for antipodal samples (cos_c < -0.9)
 *  to match the WGSL `return vec2<f32>(1e15, 1e15)` branch. CPU
 *  `stereographic.forward` returns [NaN, NaN] for the same range —
 *  another CPU/WGSL convention divergence worth documenting. */
export function projStereographicWgsl(lon: number, lat: number, clon: number, clat: number): [number, number] {
  const lam = lon * DEG2RAD, phi = lat * DEG2RAD
  const l0 = clon * DEG2RAD, p0 = clat * DEG2RAD
  const cc = Math.sin(p0) * Math.sin(phi) + Math.cos(p0) * Math.cos(phi) * Math.cos(lam - l0)
  if (cc < -0.9) return [1e15, 1e15]
  const k = 2.0 / (1.0 + cc)
  return [
    EARTH_R * k * Math.cos(phi) * Math.sin(lam - l0),
    EARTH_R * k * (Math.cos(p0) * Math.sin(phi) - Math.sin(p0) * Math.cos(phi) * Math.cos(lam - l0)),
  ]
}

/** Mirror of `fn proj_oblique_mercator` in raster-renderer.ts:80. */
export function projObliqueMercatorWgsl(lon: number, lat: number, clon: number, clat: number): [number, number] {
  const lam = lon * DEG2RAD, phi = lat * DEG2RAD
  const l0 = clon * DEG2RAD, p0 = clat * DEG2RAD
  const dLam = lam - l0
  const lamRot = Math.atan2(
    Math.cos(phi) * Math.sin(dLam),
    Math.cos(p0) * Math.sin(phi) - Math.sin(p0) * Math.cos(phi) * Math.cos(dLam),
  )
  const phiRot = Math.asin(Math.max(-1, Math.min(1,
    Math.sin(p0) * Math.sin(phi) + Math.cos(p0) * Math.cos(phi) * Math.cos(dLam),
  )))
  const phiShifted = phiRot - Math.PI / 2
  const yLat = Math.max(-1.5, Math.min(1.5, phiShifted))
  return [EARTH_R * lamRot, EARTH_R * Math.log(Math.tan(Math.PI / 4 + yLat / 2))]
}
