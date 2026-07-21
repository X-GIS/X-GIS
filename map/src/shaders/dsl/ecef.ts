// ═══ Shader DSL — ECEF helpers (DSL-authored) ═══
//
// ECEF (Earth-Centered Earth-Fixed) Cartesian math for the Tier-3 vertex pipeline.
// Authored as DSL functions (not raw WGSL strings) so the math is type-checked,
// CPU-evaluable (cross-validated against runtime/src/engine/projection/ecef.ts), and
// backend-portable. The ECEF_WGSL_* exports are now DERIVED by emitting these DSL
// fns/consts — line.ts / raster.ts still import the same names, so they pick up the
// DSL-emitted WGSL with no call-site change. (Was: hand-written WGSL template literals.)

import {
  fn,
  f32,
  f32T,
  vec3,
  vec3fT,
  sin,
  cos,
  sqrt,
  type ConstDecl,
  type FuncDecl,
} from '@xgis/shader-dsl'
import { emitConst, emitFuncs } from '@xgis/shader-dsl'
import { WGS84_A, WGS84_E2 } from './consts'

/** WGS84 ellipsoid constants — semi-major axis (m) + eccentricity² (= f·(2−f)
 *  with f = 1/298.257223563). These are the shipped Earth DEFAULTS; the
 *  body-consts seam (map/src/body-consts.ts) routes them through the active Body
 *  at map construction. #1152 INC-3 un-pinned #798 PIN #2: WGS84_E2 now spells the
 *  SAME f·(2−f) value EARTH.e2 holds (0.0066943799901413165) rather than the
 *  retired divergent GPU literal (0.0066943799901975955). The two differ by
 *  5.63e-14 absolute — four orders below the f32 ULP at 0.0067 (4.66e-10) — so
 *  Math.fround collapses both to the identical f32 (0.006694380193948746): the
 *  compiled shader constant is bit-unchanged, GPU pixel impact is exactly zero.
 *  body-consts.test.ts pins that zero-delta identity + defaults===EARTH bit-equality. */
export const ECEF_CONSTS: ConstDecl[] = [
  { name: 'WGS84_A', type: f32T, wgslValue: 6378137.0, cpuValue: 6378137.0 },
  {
    name: 'WGS84_E2',
    type: f32T,
    // eslint-disable-next-line no-loss-of-precision -- exact WGS84 e^2; the extra digits document the defined value (f32-compiled)
    wgslValue: 0.0066943799901413165,
    // eslint-disable-next-line no-loss-of-precision -- exact WGS84 e^2; the extra digits document the defined value (f32-compiled)
    cpuValue: 0.0066943799901413165,
  },
]

/** lon/lat (radians) + height (m) → ECEF (m). Mirrors lonLatToECEF on the CPU side. */
export const lonlatToEcef = fn(
  'lonlat_to_ecef',
  { lon_rad: f32T, lat_rad: f32T, height: f32T },
  (p) => {
    const sinLat = sin(p.lat_rad)
    const cosLat = cos(p.lat_rad)
    const n = WGS84_A.div(sqrt(f32(1).sub(WGS84_E2.mul(sinLat).mul(sinLat))))
    const x = n.add(p.height).mul(cosLat).mul(cos(p.lon_rad))
    const y = n.add(p.height).mul(cosLat).mul(sin(p.lon_rad))
    const z = n.mul(f32(1).sub(WGS84_E2)).add(p.height).mul(sinLat)
    return vec3(x, y, z)
  },
)

/** DSFUN reconstruction: rtc = hi + lo (the VS sums the ECEF-RTC pair). */
export const ecefRtcReconstruct = fn(
  'ecef_rtc_reconstruct',
  { pos_h: vec3fT, pos_l: vec3fT },
  (p) => p.pos_h.add(p.pos_l),
)

export const ECEF_FUNCS: FuncDecl[] = [lonlatToEcef, ecefRtcReconstruct]

// Derived WGSL — the same export names line.ts / raster.ts already import.
/** Emitted-WGSL accessor for the parity/structure test harnesses — they splice this exact WGSL into a standalone test shader to verify CPU↔GPU parity. NOT a production path (runtime shaders are built via emitModule, not string-prepend); the emit layer is private, so this string accessor is the sanctioned public surface for those harnesses. */
export const ECEF_WGSL_CONSTS = `${ECEF_CONSTS.map(emitConst).join('\n')}\n`
/** Emitted-WGSL accessor for the parity/structure test harnesses — they splice this exact WGSL into a standalone test shader to verify CPU↔GPU parity. NOT a production path (runtime shaders are built via emitModule, not string-prepend); the emit layer is private, so this string accessor is the sanctioned public surface for those harnesses. */
export const ECEF_WGSL_FNS = `${emitFuncs(ECEF_FUNCS)}\n`
