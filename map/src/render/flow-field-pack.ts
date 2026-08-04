// ═══ Vector-field (u,v) texture packing for the flow layer (#1333) ═══
//
// Turns an S-100 speed + direction band pair into the two half-float textures the flow
// pass advects through (design: docs/plans/2026-07-27-grid-vector-field-flow-visualization.md).
// Pure CPU, no GPU — so the encoding is unit-tested without a device, matching how
// coverage-material.ts keeps packCoverageValueValid testable.
//
// TWO DECISIONS ARE LOAD-BEARING HERE, both inherited rather than re-derived:
//
// 1. COMPONENTS, NOT SPEED + DIRECTION. The flow pass reads the field through a FILTERING
//    sampler, and filtering is linear interpolation of whatever is stored. Interpolating a
//    direction in DEGREES is wrong across the 0/360 wrap — 350° and 10° average to 180°, the
//    exact opposite of the correct 0° — and direction is undefined at zero speed. Components
//    have no wrap and degrade to (0,0) when calm. This is the same rule
//    `data/src/coverage/interpolate-vector.ts` already applies CPU-side; using it here makes
//    it ONE rule applied in both places rather than two encodings to keep consistent.
//
// 2. TWO r16float TEXTURES, NOT ONE rg16float. coverage-material.ts's A3 note records that
//    rgba16float is rejected on WebGL2, which is why the scalar path already ships two
//    separate r16float textures. That was paid for once; this mirrors it rather than
//    re-litigating a format question on the backend that is hardest to verify from here.
//
// STORAGE IS NORMALIZED, for the same reason the scalar path normalizes: raw values in f16
// carry an offset-dependent error. Components are divided by a per-coverage `scale` (the
// field's peak speed) so both channels land in [-1, 1], bounding the f16 error at ~2⁻¹¹ of
// the field's own range; the shader multiplies `scale` back in. A calm or all-nodata field
// yields scale 0 and an all-zero pack — a field with no motion, which is the honest result.

import { f32ToF16 } from './material/coverage-material'
import { NODATA_CODE } from '@xgis/data'

const DEG2RAD = Math.PI / 180
const F16_ZERO = 0

export interface PackedFlowField {
  /** f16(u / scale) per cell — the EAST component texture (r16float). */
  u: Uint16Array
  /** f16(v / scale) per cell — the NORTH component texture (r16float). */
  v: Uint16Array
  /** f16(1) where the cell is real data (moving or genuinely calm), f16(0) where it is nodata —
   *  the ONE thing `u`/`v` cannot say, since both pack nodata and calm to the identical `(0, 0)`.
   *  Consumed by the advected shader's validity-gated interpolation (#1565), which needs to tell
   *  "no current" from "no data" apart before blending a node toward a neighbour. Same r16float
   *  shape as `u`/`v` so it uploads through the identical texture path. */
  valid: Uint16Array
  /** Peak speed in the source band's units. Multiply the sampled components by this to
   *  recover real velocity. 0 when the field is entirely calm or nodata. */
  scale: number
}

/** Pack a speed + direction grid into normalized east/north component textures.
 *
 *  `directionDeg` follows the S-100 convention the arrow portrayal already uses: degrees
 *  TRUE (clockwise from north), i.e. the direction the current flows TOWARD. So
 *  east = speed·sin(dir) and north = speed·cos(dir) — the same decomposition
 *  `interpolateVectorCoverage` uses, deliberately not a re-derivation.
 *
 *  A cell that is nodata in EITHER band packs to (0,0): a vector needs both halves, and
 *  inventing one would make the flow advect through a cell no forecast described. Zero is
 *  the correct fill because it means "no motion here", so an invalid region does not smear.
 *
 *  `speedCodes` / `dirCodes` are the optional u16 quantization codes; when present, code
 *  NODATA_CODE marks nodata exactly, without relying on a NaN round-trip. */
export function packFlowFieldUV(
  speed: Float32Array,
  directionDeg: Float32Array,
  speedCodes?: Uint16Array,
  dirCodes?: Uint16Array,
): PackedFlowField {
  const n = speed.length
  if (directionDeg.length !== n) {
    throw new Error(
      `[flow] packFlowFieldUV: band length mismatch — speed ${n}, direction ${directionDeg.length}`,
    )
  }
  const u = new Uint16Array(n)
  const v = new Uint16Array(n)
  const valid = new Uint16Array(n)
  const F16_ONE = f32ToF16(1)

  // Two passes: the scale must be known before anything can be normalized, and the peak has
  // to come from the SAME validity test the write pass uses or a nodata cell could set it.
  let scale = 0
  for (let i = 0; i < n; i++) {
    if (!isValid(i, speed, directionDeg, speedCodes, dirCodes)) continue
    valid[i] = F16_ONE
    const s = Math.abs(speed[i]!)
    if (s > scale) scale = s
  }
  if (scale === 0) return { u, v, valid, scale: 0 } // calm / all-nodata: already all-zero

  const inv = 1 / scale
  for (let i = 0; i < n; i++) {
    if (!isValid(i, speed, directionDeg, speedCodes, dirCodes)) {
      u[i] = F16_ZERO
      v[i] = F16_ZERO
      continue
    }
    const s = speed[i]! * inv
    const rad = directionDeg[i]! * DEG2RAD
    u[i] = f32ToF16(s * Math.sin(rad))
    v[i] = f32ToF16(s * Math.cos(rad))
  }
  return { u, v, valid, scale }
}

function isValid(
  i: number,
  speed: Float32Array,
  directionDeg: Float32Array,
  speedCodes?: Uint16Array,
  dirCodes?: Uint16Array,
): boolean {
  if (speedCodes && speedCodes[i] === NODATA_CODE) return false
  if (dirCodes && dirCodes[i] === NODATA_CODE) return false
  const s = speed[i]!
  const d = directionDeg[i]!
  return Number.isFinite(s) && Number.isFinite(d)
}
