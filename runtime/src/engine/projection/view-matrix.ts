// ═══ Pure view-matrix math — extracted from camera.ts (roadmap S9) ═══
//
// INERT refactor: every function here is the byte-identical matrix algebra
// previously inlined in `Camera._buildRTCMatrix`, `Camera._globeFrame`, and
// `Camera.getECEFFrameView`. They are PURE — no `this`, no cache shadow state,
// no preallocated instance buffers. The Camera methods keep ALL cache hit/miss
// logic and own their output buffers; they read `this.*` into a `CameraView`
// (or scalars) and call the builders below, which write into the buffer the
// caller passes as `out`.
//
// CRITICAL — float-order preservation: the arithmetic here was moved
// character-for-character from camera.ts. The multiply chain order, the
// intermediate scratch reuse, and every `(a * b) / c` association are
// load-bearing for the real-GPU matrix gate (finite_mvp / numeric_forward /
// disc_fraction). Do NOT reorder, re-associate, or "simplify".
//
// This module must NOT import camera.ts (no cycle); camera.ts imports it.

import { lonLatToECEFSphere, ecefToENURotation, type ECEF } from './ecef'
import { WORLD_MERC, TILE_PX } from '../gpu/gpu-shared'
import { buildGlobeMatrix, EARTH_R } from './globe'
import { mercatorYToLatRad } from './projection'
import { mul4, perspectiveMatrix } from './camera-helpers'

/** Resolved camera state read by the pure matrix builders. The Camera fills
 *  this from its `this.*` fields (reading the accessor-gated `pitch` once) so
 *  the builders never touch instance state. Only the fields a given builder
 *  reads are required; callers may pass a superset. */
export interface CameraView {
  /** Camera centre X in Web Mercator metres. */
  centerX: number
  /** Camera centre Y in Web Mercator metres. */
  centerY: number
  /** TRUE centre latitude in degrees (NOT the Mercator-bounded inverse of
   *  centerY) — used by the globe builder so the orbit can reach the pole. */
  centerLatDeg: number
  /** Zoom level. */
  zoom: number
  /** Bearing in degrees. */
  bearing: number
  /** Pitch in degrees (already resolved through the `pitchLocked` accessor). */
  pitch: number
  /** Field of view in degrees (Camera.FOV). */
  fovDeg: number
  /** When true, use the orthographic orbit camera in the globe builder. */
  globeOrtho: boolean
  /** Source azimuthal projType (3/4/5) for the globeOrtho framing cap. */
  azimuthalProjType: number
}

/** Module-local scratch arrays for the multiply chains. Own copies (NOT the
 *  Camera statics) so the pure builders allocate nothing per frame while
 *  preserving the exact `mul4` intermediate-reuse order from camera.ts. */
const _t1 = new Array(16).fill(0)
const _t2 = new Array(16).fill(0)
const _t3 = new Array(16).fill(0)

/** Core flat/Mercator RTC matrix builder. Writes the column-major MVP into
 *  `out` and returns the far-plane value. Byte-identical to the body of
 *  `Camera._buildRTCMatrix` (minus its cache check + cache writes, which stay
 *  on the camera). `dpr` converts the altitude term to a CSS-pixel basis;
 *  aspect ratio is DPR-invariant. `viewHeightCap` saturates the camera view
 *  height at low zoom (per-projType via the caller). */
export function buildRTCMatrix(
  view: CameraView,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
  viewHeightCap: number,
  out: Float32Array,
): { far: number } {
  const metersPerPixel = (WORLD_MERC / TILE_PX) / Math.pow(2, view.zoom)
  const m = out

  // ── Always use perspective path (no ortho/perspective discontinuity) ──
  // MVP = Perspective × Translate(0,0,-alt) × RotateX(pitch) × RotateZ(bearing)
  // Applied right-to-left: bearing → pitch → move camera up → project

  const fovRad = view.fovDeg * Math.PI / 180
  const halfFov = fovRad / 2
  const aspect = canvasWidth / canvasHeight
  const pitchRad = view.pitch * Math.PI / 180
  const bearingRad = view.bearing * Math.PI / 180

  const rawViewHeightMeters = (canvasHeight / dpr) * metersPerPixel
  const viewHeightMeters = Math.min(rawViewHeightMeters, viewHeightCap)
  const altitude = viewHeightMeters / 2 / Math.tan(halfFov)

  // Near/far planes: cover all visible ground including horizon
  const maxViewAngle = Math.min(pitchRad + halfFov, Math.PI / 2 - 0.01)
  const farthestGround = altitude / Math.cos(maxViewAngle)
  const near = Math.max(1.0, altitude * 0.01)
  const far = farthestGround * 1.5

  // Perspective matrix (column-major)
  const f = 1 / Math.tan(halfFov)
  const P = perspectiveMatrix(f, near, far, aspect)

  // Translate(0, 0, -altitude)
  const T = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, -altitude, 1,
  ]

  // RotateX(-pitch) — tilt camera backward (look down at map from ahead)
  const cp = Math.cos(-pitchRad), sp = Math.sin(-pitchRad)
  const Rx = [
    1, 0, 0, 0,
    0, cp, sp, 0,
    0, -sp, cp, 0,
    0, 0, 0, 1,
  ]

  // RotateZ(bearing)
  const cb = Math.cos(bearingRad), sb = Math.sin(bearingRad)
  const Rz = [
    cb, sb, 0, 0,
    -sb, cb, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]

  // MVP = P × T × Rx × Rz  (right-to-left: bearing → pitch → translate → project)
  mul4(_t1, Rx, Rz)      // t1 = Rx × Rz
  mul4(_t2, T, _t1)       // t2 = T × (Rx × Rz)
  mul4(_t3, P, _t2)       // t3 = P × T × Rx × Rz

  for (let i = 0; i < 16; i++) m[i] = _t3[i]
  return { far }
}

/** Globe orbit view-projection (RTC, focus-relative). Pure mirror of the body
 *  of `Camera._globeFrame`: derives lon from the Mercator centerX, reads the
 *  maintained true centre latitude, delegates to `buildGlobeMatrix`, writes the
 *  RTC matrix into `out`, and surfaces far + the absolute-ECEF eye. */
export function buildGlobeFrame(
  view: CameraView,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
  out: Float32Array,
): { far: number; eye: ECEF } {
  const R = EARTH_R
  const lon = view.centerX / R * (180 / Math.PI)
  // Read the maintained true centre latitude (NOT mercatorYToLat(centerY),
  // which saturates at ±85.051129) so the globe orbit can reach the pole.
  const lat = view.centerLatDeg
  const v = buildGlobeMatrix(
    lon, lat, view.zoom, view.pitch, view.bearing,
    canvasWidth / dpr, canvasHeight / dpr,
    view.globeOrtho, view.azimuthalProjType,
  )
  out.set(v.rtcMatrix)
  return { far: v.far, eye: v.eye }
}

/** ECEF-MVP builder for the polygon ECEF pipeline. Pure mirror of the matrix
 *  algebra in `Camera.getECEFFrameView` (the non-globe branch, minus its cache
 *  check + cache writes). Built in true-ENU-metre semantics with the cos(lat)
 *  altitude correction; composes the legacy 2D-camera chain with the ECEF→ENU
 *  rotation at the camera anchor. Writes the column-major MVP into `out` and
 *  returns far. */
export function buildECEFFrameView(
  view: CameraView,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
  out: Float32Array,
): { far: number } {
  // 1. cam_lon, cam_lat from canonical Mercator centerX/centerY.
  const RAD2DEG = 180 / Math.PI
  const cam_lon = (view.centerX / EARTH_R) * RAD2DEG
  const cam_lat = mercatorYToLatRad(view.centerY) * RAD2DEG
  const cos_lat = Math.cos(cam_lat * Math.PI / 180)

  // 2. mpp/altitude in TRUE ENU metres.
  const SPHERE_VIEW_HEIGHT_M = 2 * EARTH_R   // sphere diameter
  const mpp_mercator = (WORLD_MERC / TILE_PX) / Math.pow(2, view.zoom)
  const mpp_true = mpp_mercator * cos_lat
  const rawViewHeightTrueM = (canvasHeight / dpr) * mpp_true
  const viewHeightTrueM = Math.min(
    rawViewHeightTrueM,
    Math.min(WORLD_MERC * cos_lat, SPHERE_VIEW_HEIGHT_M),
  )

  // 3. FOV / aspect / pitch / bearing — identical to legacy build.
  const fovRad = view.fovDeg * Math.PI / 180
  const halfFov = fovRad / 2
  const aspect = canvasWidth / canvasHeight
  const pitchRad = view.pitch * Math.PI / 180
  const bearingRad = view.bearing * Math.PI / 180

  // 4. Altitude in true metres + near/far via the legacy formula.
  const altitude_true = viewHeightTrueM / 2 / Math.tan(halfFov)
  const maxViewAngle = Math.min(pitchRad + halfFov, Math.PI / 2 - 0.01)
  const farthestGround = altitude_true / Math.cos(maxViewAngle)
  const near = Math.max(1.0, altitude_true * 0.01)
  const far = farthestGround * 1.5

  // 5. Build the 4×4 chain.

  // Perspective (column-major).
  const f = 1 / Math.tan(halfFov)
  const P = perspectiveMatrix(f, near, far, aspect)
  // Translate(0, 0, -altitude_true).
  const T = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, -altitude_true, 1,
  ]
  // RotateX(-pitch).
  const cp = Math.cos(-pitchRad), sp = Math.sin(-pitchRad)
  const Rx = [
    1, 0, 0, 0,
    0, cp, sp, 0,
    0, -sp, cp, 0,
    0, 0, 0, 1,
  ]
  // RotateZ(bearing).
  const cb = Math.cos(bearingRad), sb = Math.sin(bearingRad)
  const Rz = [
    cb, sb, 0, 0,
    -sb, cb, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]
  // ECEF→ENU rotation at camera anchor (column-major Float32Array(16),
  // homogeneous identity row/column). Convert to plain array for mul4.
  const RenuF = ecefToENURotation(cam_lon, cam_lat)
  const Renu: number[] = [
    RenuF[0],  RenuF[1],  RenuF[2],  RenuF[3],
    RenuF[4],  RenuF[5],  RenuF[6],  RenuF[7],
    RenuF[8],  RenuF[9],  RenuF[10], RenuF[11],
    RenuF[12], RenuF[13], RenuF[14], RenuF[15],
  ]

  // M = P × T × Rx × Rz × Renu (right-to-left: ECEF→ENU first, then
  // legacy 2D-camera chain).
  mul4(_t1, Rx, Rz)          // t1 = Rx × Rz
  mul4(_t2, _t1, Renu)        // t2 = Rx × Rz × Renu
  mul4(_t1, T, _t2)           // t1 = T × Rx × Rz × Renu
  mul4(_t3, P, _t1)           // t3 = P × T × Rx × Rz × Renu

  const m = out
  for (let i = 0; i < 16; i++) m[i] = _t3[i]

  return { far }
}

/** Camera ECEF anchor in Cartesian metres. Pure mirror of `Camera.getECEFCenter`
 *  (sphere variant, true centre latitude). Kept here so the ECEF-derivation
 *  scalars live alongside the matrix builders; the camera method is a wrapper. */
export function ecefCenterOf(view: { centerX: number; centerLatDeg: number }): ECEF {
  const RAD2DEG = 180 / Math.PI
  return lonLatToECEFSphere((view.centerX / EARTH_R) * RAD2DEG, view.centerLatDeg)
}

/** ECEF→ENU rotation at the camera anchor. Pure mirror of
 *  `Camera.getECEFToENURotation` (lon from Mercator centerX, true centre
 *  latitude). */
export function ecefToENUOf(view: { centerX: number; centerLatDeg: number }): Float32Array {
  const RAD2DEG = 180 / Math.PI
  const lon = (view.centerX / EARTH_R) * RAD2DEG
  const lat = view.centerLatDeg
  return ecefToENURotation(lon, lat)
}
