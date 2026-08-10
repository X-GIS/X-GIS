// ═══ #777 IV3 — the pitch-0 unprojector (the ground basis's producer half) ═══
//
// `groundBasisAt` (text/ground-basis.ts) gets identity-at-pitch-0 BY CONSTRUCTION
// by composing the live projector with the inverse of the SAME projection with
// pitch forced to 0. The camera has no such inverse: `getRTCMatrixInverse` is the
// live one, cached, built from the live pitch. This module is that missing half.
//
// WHY A SEPARATE MATRIX PAIR RATHER THAN TOGGLING THE CAMERA. `Camera.pitchLocked`
// already makes `pitch` read 0, so the tempting implementation is "set it, rebuild,
// copy the inverse out, restore it". That reuses the existing path and needs no new
// matrix math — but `_buildRTCMatrix` caches on a 9-field key and `_invDirty` gates
// the invert, so both toggles have to force a rebuild, and getting it wrong leaves
// the LIVE cached matrix holding the pitch-0 version for the rest of the frame:
// every projection in the engine silently wrong, nothing thrown. This class cannot
// have that failure mode, because it never writes to the camera at all — it reads
// the same scalars, builds into ITS OWN buffers, and inverts into its own. The cost
// is a second 4×4 build + invert whenever the camera moves.
//
// The cache key deliberately EXCLUDES pitch — that is the whole point of the thing,
// and it means a pure tilt (the common interaction) is a cache hit here.
//
// SCOPE. This composes `unprojectToLonLat`, which returns null for projType 3/4/5
// (azimuthal discs — limb singularity) and 7 (globe). Under those projections there
// is no pitch-0 lon/lat, so there is no basis and the label billboards as it does
// today. Do not paper over it with a per-projection analytic fallback; see the
// two-authorities note at the head of text/ground-basis.ts.

import { WORLD_MERC, flatViewHeightCapM } from '@xgis/geo'
import { invert4x4, CAMERA_FOV_DEG } from '@xgis/shared'
import { type CameraView, buildRTCMatrix } from './view-matrix'
import { unprojectToLonLat as unprojectToLonLatPure, type UnprojectView } from './unproject'

/** The camera scalars this needs. `Camera` satisfies it structurally; a plain
 *  object does too, which is what keeps the gates below camera-free. */
export interface Pitch0View extends UnprojectView {
  centerLatDeg: number
  zoom: number
  bearing: number
  globeOrtho: boolean
  azimuthalProjType: number
}

/** Screen → lon/lat through the live projection with pitch forced to 0.
 *
 *  One instance per consumer; it owns two 16-float buffers and a cache shadow,
 *  and returns its own inverse buffer by reference (consume synchronously, as
 *  with `Camera.getRTCMatrixInverse`). */
export class Pitch0Unprojector {
  private readonly _matrix = new Float32Array(16)
  private readonly _inverse = new Float32Array(16)

  // Mirrors `Camera._viewScratch`: reused, consumed synchronously by the pure
  // builder, never retained.
  private readonly _view: CameraView = {
    centerX: 0,
    centerY: 0,
    centerLatDeg: 0,
    zoom: 0,
    bearing: 0,
    pitch: 0,
    fovDeg: CAMERA_FOV_DEG,
    globeOrtho: false,
    azimuthalProjType: 0,
  }

  // NaN/-1 sentinels guarantee a first-call miss. `pitch` is absent by design.
  private _cacheW = -1
  private _cacheH = -1
  private _cacheDpr = -1
  private _cacheCx = NaN
  private _cacheCy = NaN
  private _cacheLat = NaN
  private _cacheZoom = NaN
  private _cacheBearing = NaN
  private _cacheCap = NaN
  private _cacheOrtho = false
  private _cacheAziProj = -1

  /** The inverse MVP of the live camera with pitch forced to 0. */
  matrixInverse(
    view: Pitch0View,
    canvasWidth: number,
    canvasHeight: number,
    dpr = 1,
  ): Float32Array {
    // The SAME per-projType view-height cap `Camera.getRTCMatrixInverse` uses, so
    // at pitch 0 this inverse is the live one element for element rather than
    // merely close — ortho's cap differs from the WORLD_MERC default by ~π.
    // Keyed on the resolved CAP, not on projType: the cap is the only thing the
    // projection contributes to this matrix, so two projTypes sharing one cap are
    // genuinely one cache entry — and the projections table stays the sole place
    // that branches on projType (the #996 confinement ratchet).
    const cap = flatViewHeightCapM(view.projType, WORLD_MERC)
    if (
      canvasWidth === this._cacheW &&
      canvasHeight === this._cacheH &&
      dpr === this._cacheDpr &&
      view.centerX === this._cacheCx &&
      view.centerY === this._cacheCy &&
      view.centerLatDeg === this._cacheLat &&
      view.zoom === this._cacheZoom &&
      view.bearing === this._cacheBearing &&
      cap === this._cacheCap &&
      view.globeOrtho === this._cacheOrtho &&
      view.azimuthalProjType === this._cacheAziProj
    ) {
      return this._inverse
    }
    const v = this._view
    v.centerX = view.centerX
    v.centerY = view.centerY
    v.centerLatDeg = view.centerLatDeg
    v.zoom = view.zoom
    v.bearing = view.bearing
    v.pitch = 0
    v.fovDeg = CAMERA_FOV_DEG
    v.globeOrtho = view.globeOrtho
    v.azimuthalProjType = view.azimuthalProjType
    buildRTCMatrix(v, canvasWidth, canvasHeight, dpr, cap, this._matrix)
    invert4x4(this._matrix, this._inverse)
    this._cacheW = canvasWidth
    this._cacheH = canvasHeight
    this._cacheDpr = dpr
    this._cacheCx = view.centerX
    this._cacheCy = view.centerY
    this._cacheLat = view.centerLatDeg
    this._cacheZoom = view.zoom
    this._cacheBearing = view.bearing
    this._cacheCap = cap
    this._cacheOrtho = view.globeOrtho
    this._cacheAziProj = view.azimuthalProjType
    return this._inverse
  }

  /** The `unprojectPitch0` argument `groundBasisAt` asks for. Null for projType
   *  3/4/5/7 and when the ray misses the ground plane. */
  unprojectToLonLat(
    view: Pitch0View,
    screenX: number,
    screenY: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr = 1,
  ): [number, number] | null {
    const inv = this.matrixInverse(view, canvasWidth, canvasHeight, dpr)
    return unprojectToLonLatPure(view, inv, screenX, screenY, canvasWidth, canvasHeight)
  }
}
