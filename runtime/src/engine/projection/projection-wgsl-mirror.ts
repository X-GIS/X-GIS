// ═══ WGSL Projection Mirror (Phase 2-A) ═══
//
// TypeScript mirrors of the WGSL proj_* functions in `wgsl-projection.ts`
// (the single source of truth consumed by both renderer.ts and
// raster-renderer.ts). The runtime does GPU projection via WGSL; tile
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

/** Mirror of `fn wrap_lon_delta` in wgsl-projection.ts (and identical to
 *  projection.ts wrapLonDelta). Identity inside [-180,180] so clon = 0
 *  leaves the pseudocylindrical projections byte-unchanged. */
function wrapLonDelta(d: number): number {
  if (d > 180) return d - 360 * Math.ceil((d - 180) / 360)
  if (d < -180) return d + 360 * Math.ceil((-d - 180) / 360)
  return d
}

/** Mirror of `fn proj_mercator` in wgsl-projection.ts. */
export function projMercatorWgsl(lon: number, lat: number): [number, number] {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat))
  const x = lon * DEG2RAD * EARTH_R
  const y = Math.log(Math.tan(Math.PI / 4 + (clamped * DEG2RAD) / 2)) * EARTH_R
  return [x, y]
}

/** Mirror of `fn proj_natural_earth` in wgsl-projection.ts.
 *  Šavrič et al. (2015) 6th-order polynomial. projection.ts
 *  `naturalEarth.forward` now uses this SAME polynomial — the old
 *  table-based interpolation (which drifted ~8145 km at the poles) was
 *  removed; see the history note in projection.ts. CPU, WGSL, and this
 *  mirror agree to ≤1mm, locked by projection-wgsl-consistency.test.ts. */
export function projNaturalEarthWgsl(lon: number, lat: number, clon = 0): [number, number] {
  return projNaturalEarthDWgsl(wrapLonDelta(lon - clon), lat)
}

/** Mirror of `fn proj_natural_earth_d` — Natural Earth from an
 *  already-resolved recentred longitude delta (no internal wrap). */
export function projNaturalEarthDWgsl(lonRel: number, lat: number): [number, number] {
  const latR = lat * DEG2RAD
  const lat2 = latR * latR
  const lat4 = lat2 * lat2
  const lat6 = lat2 * lat4
  const xScale = 0.8707 - 0.131979 * lat2 + 0.013791 * lat4 - 0.0081435 * lat6
  const yVal = latR * (1.007226 + lat2 * (0.015085 + lat2 * (-0.044475 + 0.028874 * lat2 - 0.005916 * lat4)))
  return [lonRel * DEG2RAD * xScale * EARTH_R, yVal * EARTH_R]
}

/** Mirror of `fn proj_equirectangular` in wgsl-projection.ts. */
export function projEquirectangularWgsl(lon: number, lat: number, clon = 0): [number, number] {
  return projEquirectangularDWgsl(wrapLonDelta(lon - clon), lat)
}

/** Mirror of `fn proj_equirectangular_d` — equirect from an
 *  already-resolved recentred longitude delta (no internal wrap). */
export function projEquirectangularDWgsl(lonRel: number, lat: number): [number, number] {
  return [lonRel * DEG2RAD * EARTH_R, lat * DEG2RAD * EARTH_R]
}

/** Mirror of `fn unwrap_lon_near` — brings `value` into the 360°-wide
 *  window centred on `ref` → [ref − 180, ref + 180). floor() (not
 *  round()) so this matches the WGSL bit-for-bit. Used by
 *  projectGeomWgsl to keep CPU raster tile_rtc consistent with the GPU
 *  per-vertex tile projection at the antimeridian seam. */
export function unwrapLonNear(value: number, ref: number): number {
  return value - 360 * Math.floor((value - ref + 180) / 360)
}

/** Mirror of `fn unwrap_rad_near` — 2π-window analogue for the
 *  oblique_mercator rotated longitude (atan2 ±π branch cut). */
export function unwrapRadNear(value: number, ref: number): number {
  const twoPi = 2 * Math.PI
  return value - twoPi * Math.floor((value - ref + Math.PI) / twoPi)
}

/** Mirror of `fn proj_orthographic` in wgsl-projection.ts.
 *  NOTE: Unlike CPU `orthographic.forward` which returns [NaN, NaN] for
 *  back-hemisphere points, the WGSL function computes coords regardless.
 *  Back-face culling is a SEPARATE `needs_backface_cull` function — so
 *  this mirror also returns valid coords for cosC < 0. Consumers that
 *  need culling must check cosC themselves. */
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

/** Mirror of `fn proj_azimuthal_equidistant` in wgsl-projection.ts. */
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

/** Mirror of `fn proj_stereographic` in wgsl-projection.ts.
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

/** Mirror of `fn oblique_rot` — rotated (lon, lat) radians. */
export function obliqueRotWgsl(lon: number, lat: number, clon: number, clat: number): [number, number] {
  const lam = lon * DEG2RAD, phi = lat * DEG2RAD
  const l0 = clon * DEG2RAD, p0 = clat * DEG2RAD
  const dLam = lam - l0
  const phiRot = Math.asin(Math.max(-1, Math.min(1,
    Math.sin(phi) * Math.cos(p0) - Math.cos(phi) * Math.sin(p0) * Math.cos(dLam),
  )))
  const lamRot = Math.atan2(
    Math.cos(phi) * Math.sin(dLam),
    Math.sin(phi) * Math.sin(p0) + Math.cos(phi) * Math.cos(p0) * Math.cos(dLam),
  )
  return [lamRot, phiRot]
}

/** Mirror of `fn proj_oblique_mercator_d` — rotated frame → XY. */
export function projObliqueMercatorDWgsl(lamRot: number, phiRot: number): [number, number] {
  const MERC_LIMIT_RAD = 85.051129 * DEG2RAD
  const phiClamped = Math.max(-MERC_LIMIT_RAD, Math.min(MERC_LIMIT_RAD, phiRot))
  return [EARTH_R * lamRot, EARTH_R * Math.log(Math.tan(Math.PI / 4 + phiClamped / 2))]
}

/** Mirror of `fn proj_oblique_mercator` in wgsl-projection.ts. */
export function projObliqueMercatorWgsl(lon: number, lat: number, clon: number, clat: number): [number, number] {
  const [lamRot, phiRot] = obliqueRotWgsl(lon, lat, clon, clat)
  return projObliqueMercatorDWgsl(lamRot, phiRot)
}

/** Mirror of `fn proj_globe` in shaders/projection.ts — the true 3D
 *  globe (projType 7). Returns a 3D point ON THE SPHERE, so it is NOT
 *  part of the vec2 `projectWgsl` dispatch (projType 0..6). Canonical
 *  CPU side is projection/globe.ts `globeForward`; the consistency test
 *  pins this mirror to it (the WGSL must match the same formula). */
export function projGlobeWgsl(lon: number, lat: number): [number, number, number] {
  const lam = lon * DEG2RAD, phi = lat * DEG2RAD
  const cphi = Math.cos(phi)
  return [
    EARTH_R * cphi * Math.cos(lam),
    EARTH_R * cphi * Math.sin(lam),
    EARTH_R * Math.sin(phi),
  ]
}

// ═══ Dispatchers — mirror the WGSL `project()` / `needs_backface_cull()`
// dispatch in shaders/projection.ts (same proj_params.x encoding:
// 0=merc 1=equirect 2=natearth 3=ortho 4=azieqd 5=stereo 6=oblmerc).
//
// Any CPU computation that must land on the SAME screen position as the
// GPU per-vertex projection (label anchors in map.ts, raster tile_rtc in
// raster-renderer.ts) MUST go through these — NOT projection.ts
// `getProjection`. projection.ts is the canonical CPU projection and
// intentionally diverges from the shader on ortho/stereo back-face
// (returns NaN / different sentinel — the documented A-3 convention),
// so using it for GPU-coupled math detaches labels/rasters from the
// geometry under non-Mercator projections. These mirrors compute
// coords unconditionally exactly like the shader and defer culling to
// needsBackfaceCullWgsl, matching the GPU's project-then-cull split.

/** Mirror of WGSL `project()` in shaders/projection.ts. */
export function projectWgsl(
  projType: number, lon: number, lat: number, clon: number, clat: number,
): [number, number] {
  if (projType < 0.5) return projMercatorWgsl(lon, lat)
  if (projType < 1.5) return projEquirectangularWgsl(lon, lat, clon)
  if (projType < 2.5) return projNaturalEarthWgsl(lon, lat, clon)
  if (projType < 3.5) return projOrthographicWgsl(lon, lat, clon, clat)
  if (projType < 4.5) return projAzimuthalEquidistantWgsl(lon, lat, clon, clat)
  if (projType < 5.5) return projStereographicWgsl(lon, lat, clon, clat)
  return projObliqueMercatorWgsl(lon, lat, clon, clat)
}

/** Mirror of WGSL `project_geom()` in shaders/projection.ts. Equal to
 *  projectWgsl for every projection except the seam ones — equirect=1,
 *  natural_earth=2 (hard wrap at clon±180) and oblique_mercator=6
 *  (atan2 ±π branch cut) — where the recentred coordinate is unwrapped
 *  toward `refLon` (per-tile centre longitude) in CAMERA-RELATIVE space
 *  so a seam-straddling tile stays contiguous AND correctly placed even
 *  when the camera is near ±180°. raster-renderer.ts uses this for the
 *  CPU tile_rtc SW corner so the telescoping `project_geom(v) −
 *  project_geom(SW) + tile_rtc` stays exact at the seam. */
export function projectGeomWgsl(
  projType: number, lon: number, lat: number, clon: number, clat: number, refLon: number,
): [number, number] {
  if (projType > 0.5 && projType < 2.5) {
    const refD = wrapLonDelta(refLon - clon)
    const d = unwrapLonNear(lon - clon, refD)
    return projType < 1.5 ? projEquirectangularDWgsl(d, lat) : projNaturalEarthDWgsl(d, lat)
  }
  if (projType > 5.5) {
    const [lamRot, phiRot] = obliqueRotWgsl(lon, lat, clon, clat)
    const [refLamRot] = obliqueRotWgsl(refLon, clat, clon, clat)
    return projObliqueMercatorDWgsl(unwrapRadNear(lamRot, refLamRot), phiRot)
  }
  return projectWgsl(projType, lon, lat, clon, clat)
}

/** Mirror of WGSL `needs_backface_cull()` in shaders/projection.ts.
 *  Positive ⇒ visible, negative ⇒ cull. Thresholds match the shader
 *  byte-for-byte: ortho returns raw cos(c) (cull when < 0), azimuthal
 *  culls at cc ≤ -0.85, stereographic at cc ≤ -0.8. oblique_mercator is
 *  cylindrical (the whole sphere maps to a strip, like Mercator) so it
 *  is NEVER hemisphere-culled — same as the flat projections and
 *  natural_earth. */
export function needsBackfaceCullWgsl(
  projType: number, lon: number, lat: number, clon: number, clat: number,
): number {
  if (projType > 2.5) {
    const cc = cosC(lon, lat, clon, clat)
    if (projType < 3.5) return cc
    if (projType < 4.5) return cc > -0.85 ? 1 : -1
    if (projType < 5.5) return cc > -0.8 ? 1 : -1
    if (projType < 6.5) return 1 // oblique_mercator — cylindrical, no back-face
    return cc // globe (7) — true sphere, strict hemisphere like ortho
  }
  return 1
}
