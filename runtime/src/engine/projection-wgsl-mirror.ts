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
