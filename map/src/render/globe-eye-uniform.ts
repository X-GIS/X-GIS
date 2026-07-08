// ═══ #600 — globe(7) eye-horizon cull uniform (globe_eye) ═══
//
// The globe(7) back-face cull switched from the PITCH-INVARIANT centre-
// hemisphere model (great-circle angle from clon/clat) to the EYE-HORIZON cap:
// a surface point P faces the eye iff
//   dot(normalize(P), normalize(eye)) > EARTH_R / |eye|   (the sphere horizon cut).
// The shader reads this via a `globe_eye: vec4` uniform = (normalize(eye_ecef),
// EARTH_R/|eye_ecef|). This is the SAME model the globe TILE selector
// (globe.ts: horizonCos = EARTH_R/eyeLen, eyeN = eye/eyeLen) and the label
// projector (render-loop-helpers.ts) already use — so the per-fragment GPU cull
// vanishes at EXACTLY the tile/label horizon.
//
// Single source for the five CPU uniform writers (vector-tile-renderer,
// renderer non-tiled, graticule-renderer, point-renderer, raster-renderer,
// heatmap-renderer) so the packed value cannot drift between surfaces.
// `EARTH_R` is imported from globe.ts — the SAME constant the tile cull divides
// by — so the shader horizon matches the tile horizon by construction.

import { EARTH_R } from '@xgis/geo'

/** Reusable scratch — callers copy the 4 components into their uniform
 *  immediately (single-threaded frame build, like the camera matrix buffers). */
const _scratch: [number, number, number, number] = [0, 0, 0, 0]

/** Pack the globe_eye uniform from the frame's absolute sphere-ECEF camera
 *  position (GlobeView.eye, present only on the globe / 3D ECEF branch). Returns
 *  (normalize(eye).xyz, EARTH_R/|eye|). Flat / disc paths have no eye → all-zero
 *  (the disc/flat cull arms ignore globe_eye). A degenerate |eye|≈0 also yields
 *  all-zero (never reached for a real orbit camera, but keeps the divide safe).
 *
 *  Returns a SHARED scratch tuple — read it out before the next call. */
export function globeEyeUniform(
  eye?: readonly [number, number, number],
): readonly [number, number, number, number] {
  if (!eye) {
    _scratch[0] = 0
    _scratch[1] = 0
    _scratch[2] = 0
    _scratch[3] = 0
    return _scratch
  }
  const len = Math.hypot(eye[0], eye[1], eye[2])
  if (len <= 0) {
    _scratch[0] = 0
    _scratch[1] = 0
    _scratch[2] = 0
    _scratch[3] = 0
    return _scratch
  }
  _scratch[0] = eye[0] / len
  _scratch[1] = eye[1] / len
  _scratch[2] = eye[2] / len
  _scratch[3] = EARTH_R / len // horizonCos = R/|eye| (matches globe.ts tile cull)
  return _scratch
}
