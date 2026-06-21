// ═══ Shader DSL — ECEF helpers (Phase 2 PR 2a scaffolding) ═══
//
// WGSL helpers for ECEF (Earth-Centered Earth-Fixed) Cartesian math, used by
// the Tier 3 vertex pipeline once polygon/line/point/raster VSes drop their
// non-linear `project_geom` call and become `mvp * vec4(ecef_rtc, 1)`.
//
// Phase 2 PR 2a ships the WGSL source strings; no shader currently inlines
// them. PR 2c (polygon VS migration) is the first consumer.
//
// CPU mirror lives in `runtime/src/engine/projection/ecef.ts` — same
// constants, same formulas. Cross-validation tests at
// `runtime/src/engine/projection/ecef.test.ts`.

/** WGS84 ellipsoid constants — semi-major axis (m) + eccentricity² (= 2f - f²
 *  with f = 1/298.257223563). Inlined as f32 literals; the polygon VS
 *  already has the WORLD_MERC / EARTH_R constant inlining pattern. */
export const ECEF_WGSL_CONSTS = /* wgsl */`
const WGS84_A: f32 = 6378137.0;
const WGS84_E2: f32 = 0.0066943799901975955;  // 2f - f² for f = 1/298.257223563
const DEG2RAD_F: f32 = 0.017453292519943295;
`

/** WGSL function: lon/lat (radians) + height (m) → ECEF (m).
 *  Mirrors `lonLatToECEF` on the CPU side. Caller converts lon/lat from
 *  degrees up front if needed. */
export const ECEF_WGSL_FNS = /* wgsl */`
fn lonlat_to_ecef(lon_rad: f32, lat_rad: f32, height: f32) -> vec3<f32> {
  let sin_lat: f32 = sin(lat_rad);
  let cos_lat: f32 = cos(lat_rad);
  let n: f32 = WGS84_A / sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat);
  let x: f32 = (n + height) * cos_lat * cos(lon_rad);
  let y: f32 = (n + height) * cos_lat * sin(lon_rad);
  let z: f32 = (n * (1.0 - WGS84_E2) + height) * sin_lat;
  return vec3<f32>(x, y, z);
}

// DSFUN reconstruction: rtc = hi + lo. The polygon VS in Phase 2 PR 2c
// will read pos_h + pos_l as ECEF-RTC pairs and sum them as the first
// line of the VS body, matching the Mercator pos_h + pos_l pattern.
fn ecef_rtc_reconstruct(pos_h: vec3<f32>, pos_l: vec3<f32>) -> vec3<f32> {
  return pos_h + pos_l;
}
`
