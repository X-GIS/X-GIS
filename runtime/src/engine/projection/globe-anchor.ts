// ═══ Globe-mode pointer anchors — screen↔sphere inverse for the input path ═══
//
// Wires the ray↔sphere inverse (`unprojectGlobe`, globe.ts) into the pointer
// verbs. Pre-fix, EVERY globe-mode screen→world inverse — the drag anchor, the
// zoomAt cursor anchor, the click/hover `clientToLngLat` — ran through
// `Camera.getRTCMatrixInverse`, which builds the flat Mercator-plane MVP
// UNCONDITIONALLY (camera.ts; its sibling `getRTCMatrix` DOES branch on
// globeMode). In globe mode that plane is a PHANTOM: it is not the rendered
// sphere, so the recovered "world point" is the wrong place on Earth.
// Measured against the real sphere: 16-20 px zoom-anchor drift over a
// 20-step stream (G5c) and 7-11 px drag under-cursor drift (G5d) before this
// module; both sub-0.001 px after.
//
// This module must NOT import camera.ts (no cycle); camera.ts imports it.
// Helpers take a structural `GlobeAnchorCamera` snapshot — the Camera class
// satisfies it directly (same pattern as unproject.ts `UnprojectView`).
//
// Centre writes mirror `Camera.pan`'s globe branch EXACTLY (camera.ts
// `rotateCentre` counterpart at the pan globe arm): `centerLatDeg` is
// AUTHORITATIVE for the sphere (clamped to `poleLimit`, NOT through
// `_syncCenterLatFromMercator`, which would clamp a pole-ward centre back to
// ±85.05 and undo the S12 pole-reach); `centerY` keeps the Mercator-bounded
// mirror for the 2D / tile-pyramid readers.

import { buildGlobeMatrix, unprojectGlobe, EARTH_R, type GlobeView } from './globe'
import { poleLimit } from './projections-table'

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

/** Scalar camera state the globe anchor helpers read/write. The Camera class
 *  satisfies this structurally — callers pass the camera instance itself.
 *  `pitch` is the accessor-gated value (pitchLocked honoured), same as every
 *  other matrix-builder read. */
export interface GlobeAnchorCamera {
  centerX: number
  centerY: number
  centerLatDeg: number
  zoom: number
  maxZoom: number
  pitch: number
  bearing: number
  projType: number
  globeOrtho: boolean
  azimuthalProjType: number
}

/** ABSOLUTE-coords globe view for the CURRENT camera state. Mirrors the
 *  render path's `buildGlobeFrame` (view-matrix.ts) input-for-input — lon from
 *  the Mercator centerX, the maintained TRUE centre latitude, CSS dims
 *  (device/dpr), globeOrtho + the source azimuthal projType — but keeps
 *  `matrix` (absolute sphere coords), which the ray↔sphere unproject needs;
 *  the camera's `_globeFrame` only retains the RTC variant. */
function globeViewOf(
  cam: GlobeAnchorCamera, canvasWidth: number, canvasHeight: number, dpr: number,
): GlobeView {
  return buildGlobeMatrix(
    (cam.centerX / EARTH_R) * RAD2DEG, cam.centerLatDeg,
    cam.zoom, cam.pitch, cam.bearing,
    canvasWidth / dpr, canvasHeight / dpr,
    cam.globeOrtho, cam.azimuthalProjType,
  )
}

/** Screen pixel → (lon,lat)° on the RENDERED sphere, or null off the limb.
 *  `screenX/Y` and `canvasWidth/Height` must share a pixel basis (the input
 *  path passes DEVICE px throughout — only the ratio enters the NDC; the
 *  matrix aspect/altitude use the CSS dims derived via `dpr`). */
export function unprojectGlobeFromCamera(
  cam: GlobeAnchorCamera,
  screenX: number, screenY: number,
  canvasWidth: number, canvasHeight: number,
  dpr: number,
): [number, number] | null {
  return unprojectGlobe(
    screenX, screenY, canvasWidth, canvasHeight,
    globeViewOf(cam, canvasWidth, canvasHeight, dpr),
  )
}

/** Rotate the globe centre by (dLon, dLat) degrees. Byte-pattern mirror of
 *  `Camera.pan`'s globe-branch centre write: wrapped lon; `centerLatDeg`
 *  authoritative with the `poleLimit` clamp (90° for the sphere family — the
 *  pole stays reachable); `centerY` = Mercator-bounded mirror. */
function rotateCentre(cam: GlobeAnchorCamera, dLonDeg: number, dLatDeg: number): void {
  let lon = (cam.centerX / EARTH_R) * RAD2DEG + dLonDeg
  lon = ((lon + 180) % 360 + 360) % 360 - 180
  const pl = poleLimit(cam.projType)
  const lat = Math.max(-pl, Math.min(pl, cam.centerLatDeg + dLatDeg))
  cam.centerX = lon * DEG2RAD * EARTH_R
  cam.centerLatDeg = lat
  const mercLat = Math.max(-85.051129, Math.min(85.051129, lat))
  cam.centerY = Math.log(Math.tan(Math.PI / 4 + mercLat * DEG2RAD / 2)) * EARTH_R
}

/** Wrap a lon delta into (-180, 180] so an anchor across the antimeridian
 *  rotates the short way (both operands are atan2 output in [-180, 180]). */
function wrapDeltaLon(d: number): number {
  if (d > 180) return d - 360
  if (d < -180) return d + 360
  return d
}

// Fixed-point pass cap + convergence floor. Rotating the centre about the
// polar axis shifts every surface point's lon by the same delta, so the lon
// component is EXACT in one pass; the lat component is first-order (a
// meridian orbit is not a pure screen-space shift at pitch/bearing ≠ 0) and
// converges geometrically. ≤6 passes mirrors the flat 1/2/6 zoomAt loop;
// 1e-6° ≈ 0.11 m matches that loop's 0.1 m convergence floor.
const MAX_PASSES = 6
const CONVERGED_DEG = 1e-6

/** Globe-mode `zoomAt`: pin the SPHERE point under the cursor across a zoom
 *  delta (Cesium-style), replacing the phantom flat-plane Mercator delta
 *  (measured 16-20 px drift over a 20-step stream — G5c). Cursor off the limb
 *  (null unproject) → centre-anchored zoom: the zoom still applies, the centre
 *  stays (exactly how the flat path behaves when the ray misses the ground).
 *  Mutates `cam.{zoom, centerX, centerY, centerLatDeg}`. */
export function zoomAtGlobeAnchored(
  cam: GlobeAnchorCamera,
  delta: number,
  screenX: number, screenY: number,
  canvasWidth: number, canvasHeight: number,
  dpr: number,
): void {
  const before = unprojectGlobeFromCamera(cam, screenX, screenY, canvasWidth, canvasHeight, dpr)
  // Same clamp as the flat zoomAt arms.
  cam.zoom = Math.max(0, Math.min(cam.maxZoom, cam.zoom + delta))
  if (!before) return
  for (let i = 0; i < MAX_PASSES; i++) {
    const cur = unprojectGlobeFromCamera(cam, screenX, screenY, canvasWidth, canvasHeight, dpr)
    if (!cur) break
    const dLon = wrapDeltaLon(before[0] - cur[0])
    const dLat = before[1] - cur[1]
    rotateCentre(cam, dLon, dLat)
    if (Math.abs(dLon) < CONVERGED_DEG && Math.abs(dLat) < CONVERGED_DEG) break
  }
}

/** Globe-mode `panToScreenAnchor`: rotate the centre so the lon/lat grabbed at
 *  drag start returns under the cursor (ground-tracking drag). The anchor
 *  space is GEOGRAPHIC degrees — NOT Mercator metres — so a pole-ward anchor
 *  (|lat| > 85.05) keeps working through the centerLatDeg pole semantics.
 *  Cursor off the limb mid-drag → leave the camera as-is (mirrors the flat
 *  path's "ray missed ground" no-op; an off-limb POINTERDOWN never reaches
 *  here — the controller's null-anchor fallback delta-pans via `camera.pan`).
 *  Mutates `cam.{centerX, centerY, centerLatDeg}`. */
export function panGlobeToScreenAnchor(
  cam: GlobeAnchorCamera,
  anchorLonDeg: number, anchorLatDeg: number,
  screenX: number, screenY: number,
  canvasWidth: number, canvasHeight: number,
  dpr: number,
): void {
  for (let i = 0; i < MAX_PASSES; i++) {
    const cur = unprojectGlobeFromCamera(cam, screenX, screenY, canvasWidth, canvasHeight, dpr)
    if (!cur) return
    const dLon = wrapDeltaLon(anchorLonDeg - cur[0])
    const dLat = anchorLatDeg - cur[1]
    rotateCentre(cam, dLon, dLat)
    if (Math.abs(dLon) < CONVERGED_DEG && Math.abs(dLat) < CONVERGED_DEG) return
  }
}
