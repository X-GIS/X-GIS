// ═══ Retained-arrow packer (movement vector field) ═══
//
// Sibling of retained-icon-packer.ts. Turns an ArrowDrawSpec into the two GPU-bound typed
// arrays the retained-arrow shader reads: the `feat` buffer (position DSFUN + length +
// rotation, ARROW_RETAINED_FEAT layout) and the `tint` buffer (rgba per instance). Every
// accessor runs EXACTLY ONCE here (from add()/update(), NEVER the render path) — so a
// camera move does zero per-instance CPU work. Position packing reuses the SAME ECEF/
// Mercator DSFUN math as the point/icon packers, so the shader's shared geo→clip ladder
// applies unchanged.

import { lonLatToECEF } from '@xgis/engine'
import { worldCopyMercX } from '../render/point-feature-packer'
import { parseHexColor } from '../feature-helpers'
import { EARTH } from '@xgis/shared'
import {
  ARROW_RETAINED_FEAT,
  ARROW_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/arrow-retained-feat-layout'
import type { ArrowDrawSpec, IconColor, Position, Packed } from './graphics-types'

const F = ARROW_RETAINED_FEAT.slot
const STRIDE = ARROW_RETAINED_FEAT.stride
const DEG2RAD = Math.PI / 180
const MERC_LAT_LIMIT = 85.051129
const R_MERC = EARTH.sphereR // web-Mercator sphere radius (matches the point/icon packers)

/** Resolve a `Packed<T,D>` accessor for item `i` — a function runs ONCE, a constant is
 *  returned as-is. Never invoked per frame. */
function resolve<T, D>(acc: Packed<T, D> | undefined, d: D, i: number): T | undefined {
  return typeof acc === 'function' ? (acc as (d: D, i: number) => T)(d, i) : acc
}

/** Normalise an IconColor to an rgba tuple in 0..1 (default white = identity). */
function normColor(c: IconColor | undefined): [number, number, number, number] {
  if (c === undefined) return [1, 1, 1, 1]
  if (typeof c === 'string') {
    const parsed = parseHexColor(c)
    return parsed ? [parsed[0], parsed[1], parsed[2], parsed[3]] : [1, 1, 1, 1]
  }
  return [c[0], c[1], c[2], c[3] ?? 1]
}

/** Pack the per-instance `tint` buffer (rgba). Runs getColor once per item. */
export function packRetainedArrowTint<D>(spec: ArrowDrawSpec<D>): Float32Array {
  const data = spec.data
  const n = data.length
  const tint = new Float32Array(n * ARROW_RETAINED_TINT_STRIDE)
  for (let i = 0; i < n; i++) {
    const [r, g, b, a] = normColor(resolve(spec.getColor, data[i]!, i))
    const o = i * ARROW_RETAINED_TINT_STRIDE
    tint[o] = r
    tint[o + 1] = g
    tint[o + 2] = b
    tint[o + 3] = a
  }
  return tint
}

/** Pack the per-instance `feat` buffer (position DSFUN + length + rotation). Runs
 *  getPosition / getSize / getRotation once per item; `dpr` scales the length to physical
 *  px (same convention as the icon path). */
export function packRetainedArrowFeat<D>(spec: ArrowDrawSpec<D>, dpr: number): Float32Array {
  const data = spec.data
  const n = data.length
  const feat = new Float32Array(n * STRIDE)

  for (let i = 0; i < n; i++) {
    const d = data[i]!
    const o = i * STRIDE

    // ── Position → ECEF + Mercator DSFUN (mirrors point/icon packers verbatim). ──
    const pos = resolve<Position, D>(spec.getPosition, d, i)
    const lon = pos ? pos[0] : 0
    const lat = pos ? pos[1] : 0
    const ecef = lonLatToECEF(lon, lat)
    const exH = Math.fround(ecef[0])
    const eyH = Math.fround(ecef[1])
    const ezH = Math.fround(ecef[2])
    feat[o + F.ecef_x_h] = exH
    feat[o + F.ecef_y_h] = eyH
    feat[o + F.ecef_z_h] = ezH
    feat[o + F.ecef_x_l] = ecef[0] - exH
    feat[o + F.ecef_y_l] = ecef[1] - eyH
    feat[o + F.ecef_z_l] = ecef[2] - ezH
    feat[o + F.abs_lon] = lon
    feat[o + F.abs_lat] = lat
    const mx = worldCopyMercX(lon, 0)
    const latC = Math.max(-MERC_LAT_LIMIT, Math.min(MERC_LAT_LIMIT, lat))
    const my = Math.log(Math.tan(Math.PI / 4 + (latC * DEG2RAD) / 2)) * R_MERC
    const mxH = Math.fround(mx)
    const myH = Math.fround(my)
    feat[o + F.merc_x_h] = mxH
    feat[o + F.merc_x_l] = Math.fround(mx - mxH)
    feat[o + F.merc_y_h] = myH
    feat[o + F.merc_y_l] = Math.fround(my - myH)

    // ── Arrow length (px, DPR-scaled) + screen-space rotation. ──
    feat[o + F.size] = (resolve<number, D>(spec.getSize, d, i) ?? 1) * dpr
    feat[o + F.rot_rad] = resolve<number, D>(spec.getRotation, d, i) ?? 0
  }
  return feat
}
