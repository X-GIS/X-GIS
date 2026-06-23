// ═══ Shader DSL — ECEF helpers (DSL-authored) ═══
//
// ECEF (Earth-Centered Earth-Fixed) Cartesian math for the Tier-3 vertex pipeline.
// Authored as DSL functions (not raw WGSL strings) so the math is type-checked,
// CPU-evaluable (cross-validated against runtime/src/engine/projection/ecef.ts), and
// backend-portable. The ECEF_WGSL_* exports are now DERIVED by emitting these DSL
// fns/consts — line.ts / raster.ts still import the same names, so they pick up the
// DSL-emitted WGSL with no call-site change. (Was: hand-written WGSL template literals.)

import {
  fn, f32, f32T, vec3, vec3fT, sin, cos, sqrt,
  type ConstDecl, type FuncDecl,
} from '../core/ir'
import { emitConst, emitFuncsCsed } from '../core/backends/wgsl'
import { WGS84_A, WGS84_E2 } from './consts'

/** WGS84 ellipsoid constants — semi-major axis (m) + eccentricity² (= 2f - f²
 *  with f = 1/298.257223563), and degrees→radians. */
export const ECEF_CONSTS: ConstDecl[] = [
  { name: 'WGS84_A', type: f32T, wgslValue: 6378137.0, cpuValue: 6378137.0 },
  { name: 'WGS84_E2', type: f32T, wgslValue: 0.0066943799901975955, cpuValue: 0.0066943799901975955 },
]

/** lon/lat (radians) + height (m) → ECEF (m). Mirrors lonLatToECEF on the CPU side. */
export const lonlatToEcef = fn('lonlat_to_ecef', { lon_rad: f32T, lat_rad: f32T, height: f32T }, (p) => {
  const sinLat = sin(p.lat_rad)
  const cosLat = cos(p.lat_rad)
  const n = WGS84_A.div(sqrt(f32(1).sub(WGS84_E2.mul(sinLat).mul(sinLat))))
  const x = n.add(p.height).mul(cosLat).mul(cos(p.lon_rad))
  const y = n.add(p.height).mul(cosLat).mul(sin(p.lon_rad))
  const z = n.mul(f32(1).sub(WGS84_E2)).add(p.height).mul(sinLat)
  return vec3(x, y, z)
})

/** DSFUN reconstruction: rtc = hi + lo (the VS sums the ECEF-RTC pair). */
export const ecefRtcReconstruct = fn('ecef_rtc_reconstruct', { pos_h: vec3fT, pos_l: vec3fT }, (p) => p.pos_h.add(p.pos_l))

export const ECEF_FUNCS: FuncDecl[] = [lonlatToEcef, ecefRtcReconstruct]

// Derived WGSL — the same export names line.ts / raster.ts already import.
/** @deprecated String-prepend emit path — being phased out for decl-array merge: consume the fn decls (getGpuProjectionFuncs / ECEF_FUNCS / LOG_DEPTH_FUNCS / the sdf fn decls) and let emitModule stitch + auto-cache them. */
export const ECEF_WGSL_CONSTS = `${ECEF_CONSTS.map(emitConst).join('\n')}\n`
/** @deprecated String-prepend emit path — being phased out for decl-array merge: consume the fn decls (getGpuProjectionFuncs / ECEF_FUNCS / LOG_DEPTH_FUNCS / the sdf fn decls) and let emitModule stitch + auto-cache them. */
export const ECEF_WGSL_FNS = `${emitFuncsCsed(ECEF_FUNCS)}\n`
