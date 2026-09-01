// ═══ Atmosphere pass — CPU camera-ray extraction + uniform pack (#1258) ═══
//
// The fragment shader needs a per-pixel world-space camera ray (atmosphere.ts's own header
// explains why: closest-approach-to-sphere is the exact silhouette test, not a 2D screen
// circle). That ray field is four CPU-unprojected NDC-corner directions plus their shared
// eye — `field-lattice-uniform.ts`'s `cornerRays` (#1520) is the same construction for the
// S-111 flow field's backward map. This is a SMALLER, standalone copy rather than an import
// from that module: this pass needs only the ray field itself (no ground lattice, no
// homography, no Newton correction), and field-lattice-uniform.ts's `cornerRays` is private
// to that feature. Both read the same precision argument (`unproject-dsl.ts`'s header): the
// CPU unprojects through the f64 inverse once, and the fragment shader only ever blends
// between the four results — never re-inverts anything itself.

import { invert4x4, mulVec4 } from '@xgis/shared'

/** Default limb-edge tint — a pale sky blue, straight-alpha RGBA 0..1. `XGISMap.setAtmosphere`
 *  falls back to this when a caller enables the atmosphere without naming a colour. */
export const ATMOSPHERE_DEFAULT_INNER_COLOR: readonly [number, number, number, number] = [
  0.55, 0.75, 1.0, 0.9,
]
/** Default outer-radius tint — alpha 0, so the glow fades into the already-black space
 *  background rather than painting a visible ring at its own outer edge. */
export const ATMOSPHERE_DEFAULT_OUTER_COLOR: readonly [number, number, number, number] = [
  0.02, 0.05, 0.12, 0,
]
/** MapLibre `sky-color`'s own spec default (`#88C6FC`), straight-alpha RGBA 0..1 — the
 *  ZENITH end of the sky ramp (#2052). */
export const SKY_DEFAULT_COLOR: readonly [number, number, number, number] = [
  0x88 / 255,
  0xc6 / 255,
  0xfc / 255,
  1,
]
/** MapLibre `horizon-color`'s own spec default (`#ffffff`) — the LIMB end of the ramp. */
export const SKY_DEFAULT_HORIZON_COLOR: readonly [number, number, number, number] = [1, 1, 1, 1]
/** MapLibre `sky-horizon-blend`'s own spec default. */
export const SKY_DEFAULT_HORIZON_BLEND = 0.8

const NDC_CORNERS: readonly [number, number][] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
]

function unprojectNdc(
  inv: Float64Array,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const p = mulVec4(inv, [x, y, z, 1])
  const w = p[3] || 1e-30
  return [p[0]! / w, p[1]! / w, p[2]! / w]
}

/** `w_clip` of a world point under the forward matrix — zero exactly at the eye (same
 *  identity `field-lattice-uniform.ts`'s `clipW` uses). */
function clipW(m: ArrayLike<number>, p: readonly [number, number, number]): number {
  return m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!
}

export interface AtmosphereCameraRays {
  /** World-space ray directions at NDC (−1,−1) / (+1,−1) / (−1,+1) / (+1,+1), in that order —
   *  the corner order `ray_from_corners` (unproject-dsl.ts) blends between. Not normalised. */
  readonly dirs: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ]
  /** The shared ray origin (world-space, the MVP's own frame) — solved once, on the
   *  bottom-left ray, and identical by construction for all four (the matrix is one
   *  perspective projection). */
  readonly eye: readonly [number, number, number]
}

/** The four corner rays + their shared eye, in `matrix`'s own world space. Returns `null` for
 *  a degenerate (near-orthographic) matrix — `|w_clip| ~ 0` along the ray, so there is no
 *  finite eye to solve for. The caller's pass no-ops on `null`, same contract as
 *  `field-lattice-uniform.ts`'s `writeFieldViewUniform`. */
export function atmosphereCameraRays(matrix: Float32Array): AtmosphereCameraRays | null {
  const inv = new Float64Array(16)
  if (!invert4x4(matrix, inv)) return null
  const dirs: [number, number, number][] = []
  let eye: [number, number, number] | null = null
  for (const [x, y] of NDC_CORNERS) {
    const near = unprojectNdc(inv, x, y, -1)
    const far = unprojectNdc(inv, x, y, 1)
    const d: [number, number, number] = [far[0] - near[0], far[1] - near[1], far[2] - near[2]]
    dirs.push(d)
    if (eye === null) {
      const wn = clipW(matrix, near)
      const wf = clipW(matrix, far)
      const dw = wf - wn
      if (Math.abs(dw) < 1e-12) return null
      const t = -wn / dw
      eye = [near[0] + t * d[0], near[1] + t * d[1], near[2] + t * d[2]]
    }
  }
  if (eye === null || dirs.length !== 4) return null
  return { dirs: [dirs[0]!, dirs[1]!, dirs[2]!, dirs[3]!], eye }
}
