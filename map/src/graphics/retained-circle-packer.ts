// ═══ Retained-circle packer (disc primitive) ═══
//
// Sibling of retained-arrow-packer.ts. Turns a CircleDrawSpec into the two GPU-bound typed arrays
// the retained-circle shader reads: the `feat` buffer (geo anchor DSFUN + radius + stroke width +
// stroke rgba, CIRCLE_RETAINED_FEAT layout) and the `tint` buffer (fill rgba). Every accessor runs
// EXACTLY ONCE here (add()/update(), never per frame). Position packing reuses the SAME ECEF/
// Mercator DSFUN math as the point/icon/arrow packers, so the shader's shared geo→clip ladder
// applies unchanged.

import {
  WHITE_RGBA,
  normColor,
  packGeoPointDsfun,
  packRetainedTint,
  resolve,
} from './retained-pack-common'
import { CIRCLE_RETAINED_FEAT } from '../shaders/dsl/circle-retained-feat-layout'
import type { CircleDrawSpec, Position } from './graphics-types'

const F = CIRCLE_RETAINED_FEAT.slot
const STRIDE = CIRCLE_RETAINED_FEAT.stride
/** A circle's stroke defaults to TRANSPARENT (no ring) — unlike every other retained
 *  colour, whose default is opaque white. */
const NO_STROKE: readonly [number, number, number, number] = [0, 0, 0, 0]

/** Pack the per-instance `tint` buffer (fill rgba). Runs getColor once per item. */
export function packRetainedCircleTint<D>(spec: CircleDrawSpec<D>): Float32Array {
  return packRetainedTint(spec.data, spec.getColor, WHITE_RGBA)
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

    packGeoPointDsfun(feat, o + F.ecef_x_h, lon, lat)

    feat[o + F.radius_px] = (resolve<number, D>(spec.getRadius, d, i) ?? 4) * dpr
    feat[o + F.stroke_width_px] = (resolve<number, D>(spec.getStrokeWidth, d, i) ?? 0) * dpr
    const [sr, sg, sb, sa] = normColor(resolve(spec.getStrokeColor, d, i), NO_STROKE)
    feat[o + F.stroke_r] = sr
    feat[o + F.stroke_g] = sg
    feat[o + F.stroke_b] = sb
    feat[o + F.stroke_a] = sa
  }
  return feat
}
