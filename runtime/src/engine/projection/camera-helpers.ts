// ═══ Matrix Utilities — pure helpers extracted from camera.ts ═══

/** Inverse of `proj_orthographic` (shaders/projection.ts): disc-plane
 *  metres (relative to the projection centre `lon0`/`lat0`, radians) →
 *  geographic `[lon, lat]` radians. Snyder's azimuthal-orthographic
 *  inverse. Returns the centre itself for points at/near the origin and
 *  clamps the limb so a finger just off the disc still resolves. */
export function invOrthographic(x: number, y: number, lon0: number, lat0: number): [number, number] {
  const R = 6378137
  const rho = Math.hypot(x, y)
  if (rho < 1e-6) return [lon0, lat0]
  const c = Math.asin(Math.min(1, rho / R))
  const sinC = Math.sin(c), cosC = Math.cos(c)
  const sinP0 = Math.sin(lat0), cosP0 = Math.cos(lat0)
  const lat = Math.asin(cosC * sinP0 + (y * sinC * cosP0) / rho)
  const lon = lon0 + Math.atan2(x * sinC, rho * cosC * cosP0 - y * sinC * sinP0)
  return [lon, lat]
}

/** Inverse of the codebase azimuthal-equidistant forward (CPU canonical
 *  `azimuthalEquidistant().forward` in projection.ts; GPU mirror
 *  `proj_azimuthal_equidistant`, shaders/projection.ts): disc-plane metres
 *  (relative to the projection centre `lon0`/`lat0`, radians) → geographic
 *  `[lon, lat]` radians. The forward scales by k = c/sin(c), so ρ = R·c
 *  EXACTLY — the inverse is c = ρ/R (Snyder's azimuthal-equidistant
 *  inverse, same R = 6378137). Returns the centre for points at/near the
 *  origin; clamps past-the-antipode input (ρ > πR — the sphere has run
 *  out) to the antipode so a cursor off the world disc still resolves
 *  (the analog of invOrthographic's limb clamp). The asin argument is
 *  clamped to ±1: at the pole/antipode it is analytically ±1 and FP
 *  rounding may overshoot into NaN, which would poison zoomAt's centre
 *  write. */
export function invAzimuthalEquidistant(x: number, y: number, lon0: number, lat0: number): [number, number] {
  const R = 6378137
  const rho = Math.hypot(x, y)
  if (rho < 1e-6) return [lon0, lat0]
  const c = Math.min(Math.PI, rho / R)
  const sinC = Math.sin(c), cosC = Math.cos(c)
  const sinP0 = Math.sin(lat0), cosP0 = Math.cos(lat0)
  const lat = Math.asin(Math.max(-1, Math.min(1, cosC * sinP0 + (y * sinC * cosP0) / rho)))
  const lon = lon0 + Math.atan2(x * sinC, rho * cosC * cosP0 - y * sinC * sinP0)
  return [lon, lat]
}

/** Inverse of the codebase stereographic forward (CPU canonical
 *  `stereographic().forward` in projection.ts; GPU mirror
 *  `proj_stereographic`, shaders/projection.ts): the forward scales by
 *  k = 2/(1+cos c), i.e. ρ = 2R·tan(c/2), so the inverse is
 *  c = 2·atan2(ρ, 2R) (Snyder's spherical stereographic inverse, same
 *  R = 6378137) — finite for every finite ρ (the antipode sits at ρ = ∞),
 *  so no domain clamp is needed. Same centre conventions + asin clamp as
 *  invAzimuthalEquidistant. */
export function invStereographic(x: number, y: number, lon0: number, lat0: number): [number, number] {
  const R = 6378137
  const rho = Math.hypot(x, y)
  if (rho < 1e-6) return [lon0, lat0]
  const c = 2 * Math.atan2(rho, 2 * R)
  const sinC = Math.sin(c), cosC = Math.cos(c)
  const sinP0 = Math.sin(lat0), cosP0 = Math.cos(lat0)
  const lat = Math.asin(Math.max(-1, Math.min(1, cosC * sinP0 + (y * sinC * cosP0) / rho)))
  const lon = lon0 + Math.atan2(x * sinC, rho * cosC * cosP0 - y * sinC * sinP0)
  return [lon, lat]
}

/** Disc-plane→geographic inverse + geo-anchor safe radius for one member of
 *  the untilted azimuthal disc set (the `promotesToGlobeWhenTilted` family:
 *  ortho 3 / azimuthal_equidistant 4 / stereographic 5). */
export interface DiscAnchor {
  /** Disc-plane metres (projection-centre-relative) → [lon, lat] radians. */
  inv: (x: number, y: number, lon0: number, lat0: number) => [number, number]
  /** Disc-plane radius (metres) inside which zoomAt may geo-anchor. Each
   *  inverse degenerates at its own radius — a sub-pixel screen move there
   *  maps to a huge lon/lat swing (the fling zoomAt guards against) — so
   *  the anchor region stops at 85% of it: ortho limb ρ=R → 0.85R;
   *  azimuthal-equidistant antipode ρ=πR → 0.85πR; stereographic pushes
   *  the antipode to ρ=∞, so 85% is taken of the ANGULAR way to it
   *  (c = 0.85π ⇒ ρ = 2R·tan(0.425π) ≈ 8.33R). */
  safeRho: number
}

const DISC_R = 6378137
const DISC_ANCHORS: Readonly<Record<number, DiscAnchor>> = {
  3: { inv: invOrthographic, safeRho: 0.85 * DISC_R },
  4: { inv: invAzimuthalEquidistant, safeRho: 0.85 * Math.PI * DISC_R },
  5: { inv: invStereographic, safeRho: 2 * DISC_R * Math.tan(0.425 * Math.PI) },
}

/** Keyed lookup — no projType equality branches (the arch ratchet confines
 *  those to projections-table.ts) — for zoomAt's disc geo-anchor branch.
 *  Callers gate on `promotesToGlobeWhenTilted(projType)` (exactly {3,4,5});
 *  an out-of-family projType (never produced behind that gate) falls back
 *  to the orthographic entry. */
export function discAnchorFor(projType: number): DiscAnchor {
  return DISC_ANCHORS[projType] ?? DISC_ANCHORS[3]
}

/** Multiply 4×4 matrix (column-major) by vec4 */
export function mulVec4(m: Float32Array, v: number[]): number[] {
  return [
    m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + m[12]*v[3],
    m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + m[13]*v[3],
    m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]*v[3],
    m[3]*v[0] + m[7]*v[1] + m[11]*v[2] + m[15]*v[3],
  ]
}

/** Multiply two 4×4 column-major matrices: out = a × b. (Verbatim of the
 *  loop previously inlined identically in camera.ts ×2 and globe.ts.) */
export function mul4(out: number[], a: number[], b: number[]): void {
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
 *  array body was byte-identical in camera.ts ×2 and globe.ts. */
export function perspectiveMatrix(f: number, near: number, far: number, aspect: number): number[] {
  const nf = 1 / (near - far)
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]
}

/** Invert a 4×4 column-major matrix. Writes result into `out`. */
export function invert4x4(m: Float32Array, out: Float32Array): boolean {
  const a00=m[0],a01=m[1],a02=m[2],a03=m[3]
  const a10=m[4],a11=m[5],a12=m[6],a13=m[7]
  const a20=m[8],a21=m[9],a22=m[10],a23=m[11]
  const a30=m[12],a31=m[13],a32=m[14],a33=m[15]

  const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10
  const b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12
  const b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30
  const b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32

  let det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06
  if (Math.abs(det) < 1e-15) return false
  det = 1 / det

  out[0]  = (a11*b11 - a12*b10 + a13*b09) * det
  out[1]  = (a02*b10 - a01*b11 - a03*b09) * det
  out[2]  = (a31*b05 - a32*b04 + a33*b03) * det
  out[3]  = (a22*b04 - a21*b05 - a23*b03) * det
  out[4]  = (a12*b08 - a10*b11 - a13*b07) * det
  out[5]  = (a00*b11 - a02*b08 + a03*b07) * det
  out[6]  = (a32*b02 - a30*b05 - a33*b01) * det
  out[7]  = (a20*b05 - a22*b02 + a23*b01) * det
  out[8]  = (a10*b10 - a11*b08 + a13*b06) * det
  out[9]  = (a01*b08 - a00*b10 - a03*b06) * det
  out[10] = (a30*b04 - a31*b02 + a33*b00) * det
  out[11] = (a21*b02 - a20*b04 - a23*b00) * det
  out[12] = (a11*b07 - a10*b09 - a12*b06) * det
  out[13] = (a00*b09 - a01*b07 + a02*b06) * det
  out[14] = (a31*b01 - a30*b03 - a32*b00) * det
  out[15] = (a20*b03 - a21*b01 + a22*b00) * det
  return true
}
