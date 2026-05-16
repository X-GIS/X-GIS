// ═══ Shared WGSL: Projection Functions ═══
//
// Single source of truth for the GPU projection block. Previously this
// was duplicated verbatim in renderer.ts and raster-renderer.ts; the two
// copies drifted (Mercator clamp, formatting) and any new renderer that
// wanted projection support had to copy-paste a third time.
//
// Both polygon and raster shaders now consume `WGSL_PROJECTION_FNS`,
// which keeps a single dispatch (`project(lon, lat)`) in lockstep with
// `projection.ts` (CPU canonical) and `projection-wgsl-mirror.ts`
// (TypeScript regression test). Adding or modifying a projection means
// editing this file plus the mirror — never two shader copies.
//
// ── Contract ──
// Host shader must declare the four constants; the most convenient path is
// to inline `WGSL_PROJECTION_CONSTS`:
//   const PI: f32 = 3.14159265;
//   const DEG2RAD: f32 = 0.01745329;
//   const EARTH_R: f32 = 6378137.0;
//   const MERCATOR_LAT_LIMIT: f32 = 85.051129;
//
// The dispatch entry points `project()` and `needs_backface_cull()` take
// `proj_params: vec4<f32>` as an explicit argument so different shaders
// (which name their uniform variables differently — polygon shader uses
// `u.proj_params`, line shader uses `tile.proj_params`, etc.) can all
// share the same snippet without relying on a fixed binding name.

/** Constants required by the projection functions. Concatenate before
 *  the projection function block when the host shader doesn't already
 *  declare these. */
export const WGSL_PROJECTION_CONSTS = /* wgsl */ `
const PI: f32 = 3.14159265;
const DEG2RAD: f32 = 0.01745329;
const EARTH_R: f32 = 6378137.0;
const MERCATOR_LAT_LIMIT: f32 = 85.051129;
`

/** Projection dispatch + 7 forward projections + back-face culling helper.
 *  `project()` and `needs_backface_cull()` take `proj_params: vec4<f32>`
 *  explicitly so each shader can pass its own uniform's projection params.
 *  The dispatch type encoding (`proj_params.x`):
 *    0 = mercator
 *    1 = equirectangular
 *    2 = natural_earth
 *    3 = orthographic
 *    4 = azimuthal_equidistant
 *    5 = stereographic
 *    6 = oblique_mercator
 *
 *  When changing math here, also update:
 *   - `projection.ts`              (CPU canonical, used by tile selection)
 *   - `projection-wgsl-mirror.ts`  (TS mirror tested by
 *                                   projection-wgsl-consistency.test.ts) */
export const WGSL_PROJECTION_FNS = /* wgsl */ `
fn proj_mercator(lon_deg: f32, lat_deg: f32) -> vec2<f32> {
  let lat = clamp(lat_deg, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT);
  let x = lon_deg * DEG2RAD * EARTH_R;
  let y = log(tan(PI / 4.0 + lat * DEG2RAD / 2.0)) * EARTH_R;
  return vec2<f32>(x, y);
}

// Longitude delta wrapped to [-180, 180] (identity inside the range so
// clon = 0 is byte-unchanged). IDENTICAL to projection.ts wrapLonDelta
// and projection-wgsl-mirror.ts wrapLonDelta — pseudocylindrical
// projections recentre their central meridian on clon (camera lon).
fn wrap_lon_delta(d: f32) -> f32 {
  if (d > 180.0) { return d - 360.0 * ceil((d - 180.0) / 360.0); }
  if (d < -180.0) { return d + 360.0 * ceil((-d - 180.0) / 360.0); }
  return d;
}

fn proj_equirectangular(lon_deg: f32, lat_deg: f32, clon: f32) -> vec2<f32> {
  return vec2<f32>(wrap_lon_delta(lon_deg - clon) * DEG2RAD * EARTH_R, lat_deg * DEG2RAD * EARTH_R);
}

// Natural Earth: Šavrič et al. (2015) 6th-order polynomial.
fn proj_natural_earth(lon_deg: f32, lat_deg: f32, clon: f32) -> vec2<f32> {
  let lat = lat_deg * DEG2RAD;
  let lat2 = lat * lat;
  let lat4 = lat2 * lat2;
  let lat6 = lat2 * lat4;
  let x_scale = 0.8707 - 0.131979 * lat2 + 0.013791 * lat4 - 0.0081435 * lat6;
  let y_val = lat * (1.007226 + lat2 * (0.015085 + lat2 * (-0.044475 + 0.028874 * lat2 - 0.005916 * lat4)));
  let x = wrap_lon_delta(lon_deg - clon) * DEG2RAD * x_scale * EARTH_R;
  let y = y_val * EARTH_R;
  return vec2<f32>(x, y);
}

fn proj_orthographic(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = lon_deg * DEG2RAD;
  let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD;
  let p0 = clat * DEG2RAD;
  let x = EARTH_R * cos(phi) * sin(lam - l0);
  let y = EARTH_R * (cos(p0) * sin(phi) - sin(p0) * cos(phi) * cos(lam - l0));
  return vec2<f32>(x, y);
}

// Azimuthal Equidistant — distances and bearings from the center are exact.
fn proj_azimuthal_equidistant(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = lon_deg * DEG2RAD; let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD; let p0 = clat * DEG2RAD;
  let cos_c = sin(p0) * sin(phi) + cos(p0) * cos(phi) * cos(lam - l0);
  let c = acos(clamp(cos_c, -1.0, 1.0));
  if (c < 0.0001) { return vec2<f32>(0.0, 0.0); } // at center
  let k = c / sin(c);
  let x = EARTH_R * k * cos(phi) * sin(lam - l0);
  let y = EARTH_R * k * (cos(p0) * sin(phi) - sin(p0) * cos(phi) * cos(lam - l0));
  return vec2<f32>(x, y);
}

// Stereographic — conformal (shape-preserving) about the center.
fn proj_stereographic(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = lon_deg * DEG2RAD; let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD; let p0 = clat * DEG2RAD;
  let cos_c = sin(p0) * sin(phi) + cos(p0) * cos(phi) * cos(lam - l0);
  if (cos_c < -0.9) { return vec2<f32>(1e15, 1e15); } // near antipode → clip
  let k = 2.0 / (1.0 + cos_c);
  let x = EARTH_R * k * cos(phi) * sin(lam - l0);
  let y = EARTH_R * k * (cos(p0) * sin(phi) - sin(p0) * cos(phi) * cos(lam - l0));
  return vec2<f32>(x, y);
}

// Oblique Mercator — conformal Mercator rotated so center lies on equator
// of the rotated frame. Center (clon, clat) maps to (0, 0); points to its
// rotated-north have positive y, rotated-south have negative y. Rotation
// is encoded directly into rotated lat/lon; no PI/2 shift needed.
fn proj_oblique_mercator(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> vec2<f32> {
  let lam = lon_deg * DEG2RAD; let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD; let p0 = clat * DEG2RAD;
  let d_lam = lam - l0;
  // Rotated latitude: tilt the sphere so (clon, clat) sits on the equator.
  let phi_rot = asin(clamp(
    sin(phi) * cos(p0) - cos(phi) * sin(p0) * cos(d_lam),
    -1.0, 1.0
  ));
  // Rotated longitude in the same frame.
  let lam_rot = atan2(
    cos(phi) * sin(d_lam),
    sin(phi) * sin(p0) + cos(phi) * cos(p0) * cos(d_lam)
  );
  // Mercator clamp on the rotated latitude (matches proj_mercator).
  let phi_clamped = clamp(phi_rot, -MERCATOR_LAT_LIMIT * DEG2RAD, MERCATOR_LAT_LIMIT * DEG2RAD);
  let x = EARTH_R * lam_rot;
  let y = EARTH_R * log(tan(PI / 4.0 + phi_clamped / 2.0));
  return vec2<f32>(x, y);
}

// cos(c) helper — angular distance from projection center. Used by
// back-face culling and by ortho/azimuthal/stereo dispatch internals.
fn center_cos_c(lon_deg: f32, lat_deg: f32, clon: f32, clat: f32) -> f32 {
  let lam = lon_deg * DEG2RAD; let phi = lat_deg * DEG2RAD;
  let l0 = clon * DEG2RAD; let p0 = clat * DEG2RAD;
  return sin(p0) * sin(phi) + cos(p0) * cos(phi) * cos(lam - l0);
}

// Unified dispatch — caller passes its own uniform's projection params.
fn project(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>) -> vec2<f32> {
  let t = proj_params.x;
  let clon = proj_params.y;
  let clat = proj_params.z;
  if (t < 0.5) { return proj_mercator(lon_deg, lat_deg); }
  else if (t < 1.5) { return proj_equirectangular(lon_deg, lat_deg, clon); }
  else if (t < 2.5) { return proj_natural_earth(lon_deg, lat_deg, clon); }
  else if (t < 3.5) { return proj_orthographic(lon_deg, lat_deg, clon, clat); }
  else if (t < 4.5) { return proj_azimuthal_equidistant(lon_deg, lat_deg, clon, clat); }
  else if (t < 5.5) { return proj_stereographic(lon_deg, lat_deg, clon, clat); }
  else { return proj_oblique_mercator(lon_deg, lat_deg, clon, clat); }
}

// Returns a positive value when the point is on the visible hemisphere
// (or in a flat projection where everything is visible), negative when it
// should be culled. Vertex shaders pass this as a varying; fragments
// discard on negative.
fn needs_backface_cull(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>) -> f32 {
  let t = proj_params.x;
  let clon = proj_params.y;
  let clat = proj_params.z;
  if (t > 2.5) {
    let cc = center_cos_c(lon_deg, lat_deg, clon, clat);
    if (t < 3.5) { return cc; }                                  // ortho — strict hemisphere
    if (t < 4.5) { return select(-1.0, 1.0, cc > -0.85); }       // azimuthal equidistant
    if (t < 5.5) { return select(-1.0, 1.0, cc > -0.8); }        // stereographic
    return 1.0;                                                  // oblique_mercator — cylindrical (whole sphere maps to a strip), no hemisphere back-face
  }
  return 1.0; // flat projections — no culling
}
`
