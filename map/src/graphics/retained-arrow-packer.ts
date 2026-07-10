// ═══ Retained-arrow packer (movement vector field) ═══
//
// Sibling of retained-icon-packer.ts. Turns an ArrowDrawSpec into the two GPU-bound typed
// arrays the retained-arrow shader reads: the `feat` buffer (TWO geo points — tail anchor + a
// tip one bearing-step along the direction — plus length, ARROW_RETAINED_FEAT layout) and the
// `tint` buffer (rgba). Every accessor runs EXACTLY ONCE here (add()/update(), never per frame).
// Position packing reuses the SAME ECEF/Mercator DSFUN math as the point/icon packers, so the
// shader's shared geo→clip ladder applies unchanged; the shader derives the arrow's screen
// orientation by projecting BOTH points (geo-correct under any camera — #825).

import { worldCopyMercX } from '../render/point-feature-packer'
import { parseHexColor } from '../feature-helpers'
import { EARTH, lonLatToECEF } from '@xgis/shared'
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
/** Tip offset from the anchor along the bearing, in degrees — small, so the projected screen
 *  direction is the LOCAL tangent (magnitude is irrelevant; the shader normalises it). */
const TIP_STEP_DEG = 0.02

function resolve<T, D>(acc: Packed<T, D> | undefined, d: D, i: number): T | undefined {
  return typeof acc === 'function' ? (acc as (d: D, i: number) => T)(d, i) : acc
}

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

/** Write one geo point's ECEF + Mercator DSFUN into feat[base .. base+11] (the 12-slot block
 *  shared by the tail at base 0 and the tip at base 12). Mirrors the point/icon packers. */
function packGeoPoint(feat: Float32Array, base: number, lon: number, lat: number): void {
  const ecef = lonLatToECEF(lon, lat)
  const exH = Math.fround(ecef[0])
  const eyH = Math.fround(ecef[1])
  const ezH = Math.fround(ecef[2])
  feat[base + 0] = exH
  feat[base + 1] = eyH
  feat[base + 2] = ezH
  feat[base + 3] = ecef[0] - exH
  feat[base + 4] = ecef[1] - eyH
  feat[base + 5] = ecef[2] - ezH
  feat[base + 6] = lon
  feat[base + 7] = lat
  const mx = worldCopyMercX(lon, 0)
  const latC = Math.max(-MERC_LAT_LIMIT, Math.min(MERC_LAT_LIMIT, lat))
  const my = Math.log(Math.tan(Math.PI / 4 + (latC * DEG2RAD) / 2)) * R_MERC
  const mxH = Math.fround(mx)
  const myH = Math.fround(my)
  feat[base + 8] = mxH
  feat[base + 9] = Math.fround(mx - mxH)
  feat[base + 10] = myH
  feat[base + 11] = Math.fround(my - myH)
}

/** Pack the per-instance `feat` buffer (tail + tip geo positions + length). Runs getPosition /
 *  getBearing / getSize once per item; `dpr` scales the length to physical px. The tip is the
 *  anchor stepped `TIP_STEP_DEG` along the geographic bearing (0°=north, clockwise). */
export function packRetainedArrowFeat<D>(spec: ArrowDrawSpec<D>, dpr: number): Float32Array {
  const data = spec.data
  const n = data.length
  const feat = new Float32Array(n * STRIDE)

  for (let i = 0; i < n; i++) {
    const d = data[i]!
    const o = i * STRIDE
    const pos = resolve<Position, D>(spec.getPosition, d, i)
    const lon = pos ? pos[0] : 0
    const lat = pos ? pos[1] : 0
    packGeoPoint(feat, o + F.ecef_x_h, lon, lat) // tail block (base 0)

    // Tip = anchor stepped along the geographic bearing (0=north, CW). East → lon (÷cosLat).
    const br = (resolve<number, D>(spec.getBearing, d, i) ?? 0) * DEG2RAD
    const dLat = Math.cos(br) * TIP_STEP_DEG
    const cosLat = Math.cos(lat * DEG2RAD) || 1
    const dLon = (Math.sin(br) * TIP_STEP_DEG) / cosLat
    packGeoPoint(feat, o + F.tip_ecef_x_h, lon + dLon, lat + dLat) // tip block (base 12)

    feat[o + F.size] = (resolve<number, D>(spec.getSize, d, i) ?? 1) * dpr
  }
  return feat
}
