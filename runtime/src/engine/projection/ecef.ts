// ═══ ECEF (Earth-Centered Earth-Fixed) coordinate math ═══
//
// Pure-TS helpers for the Tier 3 vertex pipeline. Every tile vertex eventually
// lands in ECEF Cartesian metres so the runtime VS becomes a linear
// `mvp * vec4(ecef_rtc, 1)` and `project_geom` non-linear dispatch goes away.
//
// WGS84 ellipsoid (the same coordinate frame 3D Tiles 1.1, Cesium World
// Terrain, and NASA-AMMOS/3DTilesRendererJS use):
//   semi-major axis (a) = 6378137 m
//   flattening (1/f)    = 298.257223563
//
// Note: the existing `projection.ts` `EARTH_RADIUS` treats Earth as a sphere
// (a = 6378137). The ECEF math here uses the same `a` but a non-zero
// flattening, so the two coordinate frames differ by ~21 km of polar
// flattening. Tier 3 Phase 2 unifies on the ellipsoid for 3D Tiles parity;
// callers that still need the sphere approximation (legacy `project_geom`
// path) keep the existing helpers untouched until Phase 2e deletes them.

const A = 6378137              // WGS84 semi-major axis (m)
const F = 1 / 298.257223563    // WGS84 flattening
const E2 = F * (2 - F)         // first eccentricity squared = 2f - f²
const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

export type ECEF = readonly [x: number, y: number, z: number]
export type LonLatHeight = readonly [lon: number, lat: number, height: number]

/** lon/lat (degrees) + ellipsoidal height (metres) → ECEF (metres). */
export function lonLatToECEF(lon: number, lat: number, height = 0): ECEF {
  const lonRad = lon * DEG2RAD
  const latRad = lat * DEG2RAD
  const sinLat = Math.sin(latRad)
  const cosLat = Math.cos(latRad)
  // Radius of curvature in the prime vertical.
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat)
  const x = (N + height) * cosLat * Math.cos(lonRad)
  const y = (N + height) * cosLat * Math.sin(lonRad)
  const z = (N * (1 - E2) + height) * sinLat
  return [x, y, z]
}

/** ECEF (metres) → lon/lat (degrees) + ellipsoidal height (metres).
 *  Closed-form Bowring iteration; converges in 1-2 iterations at terrestrial
 *  altitudes. Returns lon ∈ (-180, 180]. */
export function ecefToLonLat(x: number, y: number, z: number): LonLatHeight {
  const lon = Math.atan2(y, x)
  const p = Math.hypot(x, y)
  // Bowring's initial estimate.
  let lat = Math.atan2(z, p * (1 - E2))
  let N = A
  let height = 0
  for (let i = 0; i < 4; i++) {
    const sinLat = Math.sin(lat)
    N = A / Math.sqrt(1 - E2 * sinLat * sinLat)
    height = p / Math.cos(lat) - N
    const newLat = Math.atan2(z, p * (1 - (E2 * N) / (N + height)))
    if (Math.abs(newLat - lat) < 1e-12) {
      lat = newLat
      break
    }
    lat = newLat
  }
  return [lon * RAD2DEG, lat * RAD2DEG, height]
}

/** Web Mercator (x, y in metres) + height → ECEF.
 *  Composes the inverse Mercator (Y → latitude in radians) from
 *  `projection.ts:mercatorYToLatRad` with `lonLatToECEF`. Used by the camera
 *  to derive `_ecefCenter` from the canonical `centerX, centerY` Mercator
 *  coordinates without changing camera semantics. */
export function mercatorToECEF(mx: number, my: number, height = 0): ECEF {
  // Inline the existing inverse formula rather than importing to keep this
  // module dependency-free for tooling. Matches projection.ts byte-for-byte:
  //   `2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2`.
  const lon = (mx / A) * RAD2DEG
  const lat = (2 * Math.atan(Math.exp(my / A)) - Math.PI / 2) * RAD2DEG
  return lonLatToECEF(lon, lat, height)
}

/** DSFUN (double-single fused unit) hi/lo split of an ECEF vertex relative to
 *  an ECEF center. Mirrors the existing polygon VS pattern in `polygon.ts`
 *  (`pos_h` + `pos_l` pair) and lets the GPU reconstruct sub-mm precision
 *  from a pair of f32 vec3s where one f32 alone would lose ~0.5 m at world
 *  scale. The caller subtracts a per-tile or per-frame ECEF RTC center to
 *  bring magnitudes into the f32 sweet spot, then this split spreads the
 *  residual high/low bits across two f32 vectors.
 *
 *  Reconstruction in the VS: `rtc = hi + lo` (Kahan-style sum). */
export function dsfunSplitECEF(ecef: ECEF, ecefCenter: ECEF): { hi: ECEF; lo: ECEF } {
  const rel0 = ecef[0] - ecefCenter[0]
  const rel1 = ecef[1] - ecefCenter[1]
  const rel2 = ecef[2] - ecefCenter[2]
  // Splitting trick: cast f64 → f32 keeps the high bits, residual is the
  // discarded f64 tail. Math.fround forces the f32 round-trip.
  const hi0 = Math.fround(rel0)
  const hi1 = Math.fround(rel1)
  const hi2 = Math.fround(rel2)
  const lo0 = rel0 - hi0
  const lo1 = rel1 - hi1
  const lo2 = rel2 - hi2
  return { hi: [hi0, hi1, hi2], lo: [lo0, lo1, lo2] }
}

/** Build the 3×3 rotation matrix that takes a vector in ECEF coordinates
 *  to local ENU (East, North, Up) coordinates at the given lon/lat anchor.
 *
 *  Column-major Float32Array of length 16 (4×4 with identity in the last
 *  row/column) so it composes directly with the renderer's column-major
 *  4×4 transforms. The translation slots stay zero — the caller subtracts
 *  the ECEF anchor before applying.
 *
 *  Usage in the Phase 2 polygon VS:
 *    ecef_rtc = ecef_vertex - ecef_camera_center
 *    enu_xyz  = R_ecef_to_enu(cam_lon, cam_lat) * ecef_rtc
 *    clip     = existing_mercator_perspective_mvp * vec4(enu_xyz, 1)
 *
 *  The resulting ENU coordinate is the local Cartesian basis at the camera
 *  anchor, which agrees with the Mercator-meter basis to within tangent-
 *  plane curvature error — vanishing at the camera center and growing
 *  quadratically with horizontal extent. At z=18-class scales the error
 *  is sub-millimetre; at z=2 (whole world) the error projects to ≤ 0.5%
 *  pixel-delta on Mercator fixtures, satisfying AC2.1. */
export function ecefToENURotation(lon: number, lat: number): Float32Array {
  const lonRad = lon * DEG2RAD
  const latRad = lat * DEG2RAD
  const sLon = Math.sin(lonRad)
  const cLon = Math.cos(lonRad)
  const sLat = Math.sin(latRad)
  const cLat = Math.cos(latRad)
  // Standard geodetic ECEF → ENU rotation:
  //   E =        [-sLon,             cLon,            0    ]
  //   N = [-sLat*cLon, -sLat*sLon,   cLat ]
  //   U = [ cLat*cLon,  cLat*sLon,   sLat ]
  // Column-major: column k stores the k-th basis-vector image of x,y,z.
  // prettier-ignore
  return new Float32Array([
    -sLon,        -sLat * cLon,  cLat * cLon, 0,
     cLon,        -sLat * sLon,  cLat * sLon, 0,
     0,            cLat,         sLat,        0,
     0,            0,            0,           1,
  ])
}

/** WGS84 ellipsoid constants exported for callers that need them (DSL WGSL
 *  emission, cross-validation tests, etc.). */
export const WGS84 = {
  A,
  F,
  E2,
} as const
