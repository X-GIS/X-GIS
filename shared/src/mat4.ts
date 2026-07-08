// ═══ Generic 4×4 matrix ops (column-major) ═══
//
// Content-blind linear algebra — no geography, no GPU. Relocated from
// engine/src/projection/camera-helpers.ts (#781): these are consumed by the
// geo camera/globe math that now lives in @xgis/geo and @xgis/map, and by
// @xgis/data's tile math. Homing them in the zero-dep bedrock (alongside EARTH
// and the ECEF helpers) lets every layer share one implementation without a
// dependency on @xgis/engine or a cartography package.

/** Multiply 4×4 matrix (column-major) by vec4 */
export function mulVec4(m: Float32Array, v: number[]): number[] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ]
}

/** Multiply two 4×4 column-major matrices: out = a × b. (Verbatim of the
 *  loop previously inlined identically in camera.ts ×2 and globe.ts.) */
export function mul4(out: number[], a: ArrayLike<number>, b: ArrayLike<number>): void {
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      out[c * 4 + r] = s
    }
}

/** Column-major perspective projection matrix. `f = 1/tan(halfFov)` is
 *  passed in so each caller applies its own focal adjustment (e.g. the
 *  globe's telephoto factor); `near`/`far` frame the depth range. The
 *  array body was byte-identical in camera.ts ×2 and globe.ts. When `out`
 *  is supplied its 16 elements are written in place (same values, same
 *  indices) and `out` is returned, letting per-frame callers avoid the
 *  allocation; otherwise a fresh array is returned. */
export function perspectiveMatrix(
  f: number,
  near: number,
  far: number,
  aspect: number,
  out?: number[],
): number[] {
  const nf = 1 / (near - far)
  if (out) {
    out[0] = f / aspect
    out[1] = 0
    out[2] = 0
    out[3] = 0
    out[4] = 0
    out[5] = f
    out[6] = 0
    out[7] = 0
    out[8] = 0
    out[9] = 0
    out[10] = (far + near) * nf
    out[11] = -1
    out[12] = 0
    out[13] = 0
    out[14] = 2 * far * near * nf
    out[15] = 0
    return out
  }
  return [
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    2 * far * near * nf,
    0,
  ]
}

/** Invert a 4×4 column-major matrix. Writes result into `out`. */
export function invert4x4(m: Float32Array, out: Float32Array): boolean {
  const a00 = m[0],
    a01 = m[1],
    a02 = m[2],
    a03 = m[3]
  const a10 = m[4],
    a11 = m[5],
    a12 = m[6],
    a13 = m[7]
  const a20 = m[8],
    a21 = m[9],
    a22 = m[10],
    a23 = m[11]
  const a30 = m[12],
    a31 = m[13],
    a32 = m[14],
    a33 = m[15]

  const b00 = a00 * a11 - a01 * a10,
    b01 = a00 * a12 - a02 * a10,
    b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11,
    b04 = a01 * a13 - a03 * a11,
    b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30,
    b07 = a20 * a32 - a22 * a30,
    b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31,
    b10 = a21 * a33 - a23 * a31,
    b11 = a22 * a33 - a23 * a32

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (Math.abs(det) < 1e-15) return false
  det = 1 / det

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
  return true
}
