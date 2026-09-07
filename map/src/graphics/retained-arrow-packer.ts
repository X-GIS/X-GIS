// ═══ Retained-arrow packer (movement vector field) ═══
//
// Sibling of retained-icon-packer.ts. Turns an ArrowDrawSpec into the two GPU-bound typed
// arrays the retained-arrow shader reads: the `feat` buffer (TWO geo points — tail anchor + a
// tip one bearing-step along the direction — plus length, ARROW_RETAINED_FEAT layout) and the
// `tint` buffer (rgba). Every accessor runs EXACTLY ONCE here (add()/update(), never per frame).
// Position packing reuses the SAME ECEF/Mercator DSFUN math as the point/icon packers, so the
// shader's shared geo→clip ladder applies unchanged; the shader derives the arrow's screen
// orientation by projecting BOTH points (geo-correct under any camera — #825).

import {
  RETAINED_TINT_STRIDE,
  WHITE_RGBA,
  packGeoPointDsfun,
  packRetainedTint,
  resolve,
} from './retained-pack-common'
import { ARROW_RETAINED_FEAT } from '../shaders/dsl/arrow-retained-feat-layout'
import type { ArrowDrawSpec, Position } from './graphics-types'

const F = ARROW_RETAINED_FEAT.slot
const STRIDE = ARROW_RETAINED_FEAT.stride
const DEG2RAD = Math.PI / 180
/** Tip offset from the anchor along the bearing, in degrees — small, so the projected screen
 *  direction is the LOCAL tangent (magnitude is irrelevant; the shader normalises it). */
const TIP_STEP_DEG = 0.02

/** Pack the per-instance `tint` buffer (rgba). Runs getColor once per item. */
export function packRetainedArrowTint<D>(spec: ArrowDrawSpec<D>): Float32Array {
  return packRetainedTint(spec.data, spec.getColor, WHITE_RGBA)
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
    packGeoPointDsfun(feat, o + F.ecef_x_h, lon, lat) // tail block (base 0)

    // Tip = anchor stepped along the geographic bearing (0=north, CW). East → lon (÷cosLat).
    const br = (resolve<number, D>(spec.getBearing, d, i) ?? 0) * DEG2RAD
    const dLat = Math.cos(br) * TIP_STEP_DEG
    const cosLat = Math.cos(lat * DEG2RAD) || 1
    const dLon = (Math.sin(br) * TIP_STEP_DEG) / cosLat
    packGeoPointDsfun(feat, o + F.tip_ecef_x_h, lon + dLon, lat + dLat) // tip block (base 12)

    feat[o + F.size] = (resolve<number, D>(spec.getSize, d, i) ?? 1) * dpr
  }
  return feat
}

// ── Compiled-layer arrow packers (#1302) ──────────────────────────────
// The DECLARATIVE `| arrow bearing-[.dir]` layer draws the SAME oriented-arrow
// mesh as the retained primitive, but its per-feature values (.dir bearing,
// size, colour) are evaluated ONCE at rebuildLayers time from the source
// features — exactly like the Point fork bakes perFeatureSizes/perFeatureFills —
// not read from a host ArrowDrawSpec's accessors. These packers take those
// pre-evaluated flat arrays and fill the identical ARROW_RETAINED_FEAT / tint
// layout, so the shader + draper are reused unchanged. The TAIL+TIP DSFUN and
// bearing-step math is the SINGLE authority `packGeoPointDsfun` (no drift).

/** Pack the compiled arrow `feat` buffer from pre-evaluated per-feature arrays.
 *  `bearingsDeg` is degrees true (0 = north, clockwise); `sizesPx` is the arrow
 *  length in pre-DPR design px; `dpr` scales to physical px. Arrays are parallel
 *  (index = feature); all share `lons.length`. `strokeUnits` (default 0 = no outline)
 *  is a SINGLE constant applied to every instance in this batch — the outline stroke
 *  width in loc-space units (a fraction of each arrow's own `size`, so the border reads
 *  the same proportion regardless of band/scale); see arrow-retained-feat-layout.ts. */
export function packCompiledArrowFeat(
  lons: ArrayLike<number>,
  lats: ArrayLike<number>,
  bearingsDeg: ArrayLike<number>,
  sizesPx: ArrayLike<number>,
  dpr: number,
  strokeUnits = 0,
): Float32Array {
  const n = lons.length
  const feat = new Float32Array(n * STRIDE)
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE
    const lon = lons[i]!
    const lat = lats[i]!
    packGeoPointDsfun(feat, o + F.ecef_x_h, lon, lat) // tail block (base 0)

    // Tip = anchor stepped along the geographic bearing (0=north, CW) — identical to
    // packRetainedArrowFeat, so declarative and host arrows orient the same.
    const cosLat = Math.cos(lat * DEG2RAD) || 1
    const br = (bearingsDeg[i] ?? 0) * DEG2RAD
    const dLat = Math.cos(br) * TIP_STEP_DEG
    const dLon = (Math.sin(br) * TIP_STEP_DEG) / cosLat
    packGeoPointDsfun(feat, o + F.tip_ecef_x_h, lon + dLon, lat + dLat) // tip block (base 12)

    feat[o + F.size] = (sizesPx[i] ?? 1) * dpr
    feat[o + F.stroke_units] = strokeUnits
  }
  return feat
}

/** Pack the compiled arrow `tint` buffer from pre-evaluated per-feature rgba
 *  (0..1). Parallel to the feat array. */
export function packCompiledArrowTint(
  rgba: ArrayLike<readonly [number, number, number, number]>,
): Float32Array {
  const n = rgba.length
  const tint = new Float32Array(n * RETAINED_TINT_STRIDE)
  for (let i = 0; i < n; i++) {
    const o = i * RETAINED_TINT_STRIDE
    const c = rgba[i]!
    tint[o] = c[0]
    tint[o + 1] = c[1]
    tint[o + 2] = c[2]
    tint[o + 3] = c[3]
  }
  return tint
}
