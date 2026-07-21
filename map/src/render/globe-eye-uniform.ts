// ═══ #600 — globe(7) eye-horizon cull uniform (globe_eye) ═══
//
// The globe(7) back-face cull switched from the PITCH-INVARIANT centre-
// hemisphere model (great-circle angle from clon/clat) to the EYE-HORIZON cap.
// #1152 INC-3 moved it onto the WGS84 ELLIPSOID: a point P faces the eye iff it is
// outside the tangent plane at P — evaluated in the sphere frame that stretches z
// by a/b, this is the SAME cut `dot(q̂P, eyeN) > horizonCos` with eyeN =
// normalize(qE), horizonCos = a/|qE| (qE = the z-stretched eye). The shader reads
// (eyeN, horizonCos) via the `globe_eye: vec4` uniform and rescales its surface
// point into the same frame (globe_eye_horizon_cos). This is the SAME (a,b)
// eyeHorizon authority the globe TILE selector (globe-visible-tiles.ts) and the
// label projector (render-loop-helpers.ts) drive — so the per-fragment GPU cull
// vanishes at EXACTLY the tile/label horizon.
//
// Single source for the five CPU uniform writers (vector-tile-renderer,
// renderer non-tiled, graticule-renderer, point-renderer, raster-renderer,
// heatmap-renderer) so the packed value cannot drift between surfaces. Feeds
// eyeHorizon Earth's (a, b) = (EARTH_R, EARTH.b) — the SAME constants the globe
// TILE selector (globe-visible-tiles.ts) and label projector (render-loop-helpers.ts)
// pass, so all three horizon sites share ONE (a, b) source by construction. (The
// geo globe camera is Earth-pinned; body genericity lives on the GPU-const seam.)

import { EARTH_R } from '@xgis/geo'
import { EARTH, eyeHorizon } from '@xgis/shared'

/** Reusable scratch — callers copy the 4 components into their uniform
 *  immediately (single-threaded frame build, like the camera matrix buffers). */
const _scratch: [number, number, number, number] = [0, 0, 0, 0]

/** Pack the globe_eye uniform from the frame's absolute ECEF camera position
 *  (GlobeView.eye, present only on the globe / 3D ECEF branch). Returns the
 *  ellipsoid (a,b) scaled-frame horizon (q̂E, a/|qE|) from eyeHorizon (#1152 INC-3).
 *  Flat / disc paths have no eye → all-zero (the disc/flat cull arms ignore
 *  globe_eye). A degenerate |eye|≈0 also yields all-zero (never reached for a real
 *  orbit camera, but keeps the divide safe).
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
  const { eyeLen, eyeN, horizonCos } = eyeHorizon(eye, EARTH_R, EARTH.b)
  if (eyeLen <= 0) {
    _scratch[0] = 0
    _scratch[1] = 0
    _scratch[2] = 0
    _scratch[3] = 0
    return _scratch
  }
  _scratch[0] = eyeN[0]
  _scratch[1] = eyeN[1]
  _scratch[2] = eyeN[2]
  _scratch[3] = horizonCos // = a/|qE| (scaled-frame horizon; matches the tile cull)
  return _scratch
}
