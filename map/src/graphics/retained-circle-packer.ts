// ═══ Retained-circle packer (disc primitive) ═══
//
// Sibling of retained-arrow-packer.ts. Turns a CircleDrawSpec into the two GPU-bound typed arrays
// the retained-circle shader reads: the `feat` buffer (geo anchor DSFUN + radius + stroke width +
// stroke rgba, CIRCLE_RETAINED_FEAT layout) and the `tint` buffer (fill rgba). Every accessor runs
// EXACTLY ONCE here (add()/update(), never per frame). Position packing reuses the SAME ECEF/
// Mercator DSFUN math as the point/icon/arrow packers, so the shader's shared geo→clip ladder
// applies unchanged.

import { worldCopyMercX } from '../render/point-feature-packer'
import { parseHexColor } from '../feature-helpers'
import { EARTH, lonLatToECEF } from '@xgis/shared'
import {
  CIRCLE_RETAINED_FEAT,
  CIRCLE_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/circle-retained-feat-layout'
import type { CircleDrawSpec, IconColor, Position, Packed } from './graphics-types'

const F = CIRCLE_RETAINED_FEAT.slot
const STRIDE = CIRCLE_RETAINED_FEAT.stride
const DEG2RAD = Math.PI / 180
const MERC_LAT_LIMIT = 85.051129
const R_MERC = EARTH.sphereR // web-Mercator sphere radius (matches the point/icon/arrow packers)

function resolve<T, D>(acc: Packed<T, D> | undefined, d: D, i: number): T | undefined {
  return typeof acc === 'function' ? (acc as (d: D, i: number) => T)(d, i) : acc
}

/** Fill defaults to WHITE (opaque); stroke defaults to TRANSPARENT (no ring). */
function normColor(
  c: IconColor | undefined,
  dflt: [number, number, number, number],
): [number, number, number, number] {
  if (c === undefined) return dflt
  if (typeof c === 'string') {
    const parsed = parseHexColor(c)
    return parsed ? [parsed[0], parsed[1], parsed[2], parsed[3]] : dflt
  }
  return [c[0], c[1], c[2], c[3] ?? 1]
}

/** Pack the per-instance `tint` buffer (fill rgba). Runs getColor once per item. */
export function packRetainedCircleTint<D>(spec: CircleDrawSpec<D>): Float32Array {
  const data = spec.data
  const n = data.length
  const tint = new Float32Array(n * CIRCLE_RETAINED_TINT_STRIDE)
  for (let i = 0; i < n; i++) {
    const [r, g, b, a] = normColor(resolve(spec.getColor, data[i]!, i), [1, 1, 1, 1])
    const o = i * CIRCLE_RETAINED_TINT_STRIDE
    tint[o] = r
    tint[o + 1] = g
    tint[o + 2] = b
    tint[o + 3] = a
  }
  return tint
}

/** Pack the per-instance `feat` buffer (geo anchor DSFUN + radius + stroke). Runs getPosition /
 *  getRadius / getStrokeColor / getStrokeWidth once per item; `dpr` scales the px sizes. */
export function packRetainedCircleFeat<D>(spec: CircleDrawSpec<D>, dpr: number): Float32Array {
  const data = spec.data
  const n = data.length
  const feat = new Float32Array(n * STRIDE)

  for (let i = 0; i < n; i++) {
    const d = data[i]!
    const o = i * STRIDE
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

    feat[o + F.radius_px] = (resolve<number, D>(spec.getRadius, d, i) ?? 4) * dpr
    feat[o + F.stroke_width_px] = (resolve<number, D>(spec.getStrokeWidth, d, i) ?? 0) * dpr
    const [sr, sg, sb, sa] = normColor(resolve(spec.getStrokeColor, d, i), [0, 0, 0, 0])
    feat[o + F.stroke_r] = sr
    feat[o + F.stroke_g] = sg
    feat[o + F.stroke_b] = sb
    feat[o + F.stroke_a] = sa
  }
  return feat
}
