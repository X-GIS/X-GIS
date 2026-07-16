// ═══ Camera-anchor DSFUN split (shared by the point + heatmap frame uniforms) ═══
//
// The per-feature ECEF/Mercator position is packed ABSOLUTE (double-single float:
// a hi lane = Math.fround(v) and a lo lane = v − hi), and the frame MVP is the
// camera-at-ENU-origin view. So the frame uniform carries the CAMERA ANCHOR split
// hi/lo, and the vertex shader re-centres each feature against it via
// (featH − camH) + (featL − camL). point-renderer and heatmap-renderer computed
// this identical split inline; this is the single authority (#1006 dedup).

import type { Camera } from '../camera'

/** The camera anchor split into double-single float hi/lo lanes.
 *  `hi[i] = Math.fround(v)`, `lo[i] = v − hi[i]` per lane (z lane = 0 on the flat
 *  path). Consumers pack `hi` into `cam_ecef_h.xyz` and `lo` into `cam_ecef_l.xyz`. */
export interface CameraAnchorDsfun {
  readonly hi: readonly [number, number, number]
  readonly lo: readonly [number, number, number]
}

/** Split the camera anchor into DSFUN hi/lo lanes for the frame uniform.
 *
 *  Flat Mercator (projType 0) anchors on the 2D Mercator centre
 *  (camera.centerX/Y) with the z lane forced to 0 — the flat VS reads only the
 *  .xy lanes (`rel = project(abs) − (cam_ecef_h.xy + cam_ecef_l.xy)`, ignoring
 *  .z). Every other projection (3D / globe) anchors on the ECEF centre
 *  (camera.getECEFCenter, WGS84 ellipsoid — the tiles' datum, #1152 INC-1).
 *
 *  BYTE-IDENTICAL extraction: the emitted hi/lo values and their lane order match
 *  the split both renderers packed inline (a wrong split = wrong positions, so the
 *  math is preserved exactly — `hi = Math.fround(v)`, `lo = v − hi`, per lane). */
export function cameraAnchorDsfun(camera: Camera, projType: number): CameraAnchorDsfun {
  if (projType === 0) {
    const cmx = camera.centerX,
      cmy = camera.centerY
    const cHx = Math.fround(cmx)
    const cHy = Math.fround(cmy)
    return { hi: [cHx, cHy, 0], lo: [cmx - cHx, cmy - cHy, 0] }
  }
  const camC = camera.getECEFCenter()
  const cHx = Math.fround(camC[0])
  const cHy = Math.fround(camC[1])
  const cHz = Math.fround(camC[2])
  return { hi: [cHx, cHy, cHz], lo: [camC[0] - cHx, camC[1] - cHy, camC[2] - cHz] }
}
