// ═══ #777 IV3 — the pitch-0 view (the ground basis's producer half) ═══
//
// `groundBasisAt` (text/ground-basis.ts) gets identity-at-pitch-0 BY CONSTRUCTION
// by taking the ratio of the live and pitch-0 FORWARD Jacobians of the SAME
// projection. The camera has no pitch-0 matrix: `getRTCMatrix` is the live one,
// cached, built from the live pitch. This module is that missing half — it owns
// the pitch-0 matrix, its inverse (kept for `unprojectToLonLat`, still the
// authority for "what lon/lat is under this unpitched pixel"), and the cull-free
// forward projector the basis composes with.
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
// SCOPE. `unprojectToLonLat` composes the pure inverse, which returns null for
// projType 3/4/5 (azimuthal discs — limb singularity) and 7 (globe). The FORWARD
// projector below has no such restriction: a forward needs no inverse, so the
// azimuthal discs are in scope for the basis with no per-projection branch (design
// §3.1). The globe (projType 7) stays out, deliberately — it renders through the
// ECEF projector, has no map plane, and its deferral is recorded in §3.2 of
// docs/plans/2026-08-24-label-ground-projection.md. Do not paper over either with
// a per-projection analytic fallback; see the two-authorities note at the head of
// text/ground-basis.ts.

import { WORLD_MERC, flatViewHeightCapM } from '@xgis/geo'
import { invert4x4, CAMERA_FOV_DEG } from '@xgis/shared'
import { projMercatorCpu, projectCpu, projectGeomCpu } from '../shaders/dsl/cpu-projections'
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

  /** The MVP of the live camera with pitch forced to 0 — the FORWARD half, which
   *  `makeGroundProjector` composes into the basis's `P₀`. Same buffer, same
   *  cache, same build as `matrixInverse`; exposing it is what lets the basis be
   *  taken forward-only (design §3.1) instead of through an inverse that does not
   *  exist for every projection. Returned by reference — consume synchronously. */
  matrix(view: Pitch0View, canvasWidth: number, canvasHeight: number, dpr = 1): Float32Array {
    this._ensure(view, canvasWidth, canvasHeight, dpr)
    return this._matrix
  }

  /** The inverse MVP of the live camera with pitch forced to 0. */
  matrixInverse(
    view: Pitch0View,
    canvasWidth: number,
    canvasHeight: number,
    dpr = 1,
  ): Float32Array {
    this._ensure(view, canvasWidth, canvasHeight, dpr)
    return this._inverse
  }

  /** Rebuild `_matrix` + `_inverse` unless the cache shadow already matches. */
  private _ensure(view: Pitch0View, canvasWidth: number, canvasHeight: number, dpr: number): void {
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
      return
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
  }

  /** Screen → lon/lat through the pitch-0 projection. Null for projType 3/4/5/7
   *  and when the ray misses the ground plane. */
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

/** The flat-projection constants a ground projector composes with — exactly the
 *  fields `makeLabelProjectors`' `flat` argument carries, minus the world copies.
 *  A basis is a derivative at ONE point, so it has no copy: `projectLonLatCopies`
 *  fans an anchor out across ±360°, and the Jacobian is the same object at each. */
export interface FlatGroundView {
  projType: number
  ccx: number
  ccy: number
  centerLon: number
  centerLat: number
}

/** lon/lat → screen px, or null where the projection has no image for the point.
 *  Returns a REUSED tuple — copy out before the next call. */
export type ProjectGround = (lon: number, lat: number) => readonly [number, number] | null

/** The forward projector the ground basis is composed from: lon/lat → screen px
 *  through `mvp`, on the flat display path (projType 0-6), with the label pass's
 *  VISIBILITY culls deliberately OFF.
 *
 *  WHY CULL-FREE, and it is measured rather than assumed (design §3.1 / its
 *  NEEDS-PROBE 1). `makeLabelProjectors`' `projectLonLat` answers "should this
 *  anchor DRAW". A basis asks "how does the ground deform HERE", which is a
 *  derivative and is defined wherever the projection is. Composing it out of the
 *  culled projector loses exactly the labels the feature exists for: the pitch-0
 *  image of a pitched far field is far OUTSIDE the unpitched frame, so the NDC
 *  ±1.5 window rejects it and the far field billboards while the near field
 *  works — which reads as "the basis is subtle", not as "the basis is missing".
 *  Measured on the flat Mercator arm at 1200×800 over a 20 px lattice of
 *  on-screen anchors, identically at z4/z10/z14: 0 % rejected at pitch 30,
 *  12.2 % at 45, 24.4 % at 60, 36.6 % at 70 — every one of them in the top band
 *  of the frame, worst |ndc| 34.7. Of the three culls only that window had to go:
 *  `cw <= 0` never fired on a pitch-0 matrix (an unpitched flat MVP has no
 *  perspective term over the ground plane, so cw is the constant mvp[15]) and the
 *  ortho-rim / back-face gate reads no matrix at all, so it answers identically
 *  for the live and pitch-0 projectors and can only reject a point that has no
 *  live anchor either. `cw <= 0` is KEPT below: it is a genuine degeneracy — the
 *  point is behind the camera — not a viewport question.
 *
 *  Composition parity with `makeLabelProjectors`' flat arm is not left to
 *  inspection: `pitch0-unproject.test.ts` asserts the two agree everywhere the
 *  culled one answers, across the projType × zoom × pitch lattice. */
export function makeGroundProjector(
  mvp: Float32Array,
  canvasWidth: number,
  canvasHeight: number,
  flat: FlatGroundView,
): ProjectGround {
  const { projType, ccx, ccy, centerLon, centerLat } = flat
  const isMerc = projType < 0.5
  // `project(cam)` — the projected camera centre the non-Mercator arm subtracts,
  // exactly as `makeLabelProjectors` derives its `lblCenter`.
  const lblCenter: [number, number] = isMerc
    ? [0, 0]
    : projectCpu(projType, centerLon, centerLat, centerLon, centerLat)
  const scratch: [number, number] = [0, 0]
  return (lon: number, lat: number): readonly [number, number] | null => {
    let rtcX: number
    let rtcY: number
    if (isMerc) {
      const m = projMercatorCpu(lon, lat)
      rtcX = m[0] - ccx
      rtcY = m[1] - ccy
    } else {
      // refLon = the anchor lon, the label analog of the shader's tile-centre
      // refLon — the same argument `makeLabelProjectors` passes.
      const p = projectGeomCpu(projType, lon, lat, centerLon, centerLat, lon)
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null
      rtcX = p[0] - lblCenter[0]
      rtcY = p[1] - lblCenter[1]
    }
    const cw = mvp[3]! * rtcX + mvp[7]! * rtcY + mvp[15]!
    if (cw <= 0) return null
    const ndcX = (mvp[0]! * rtcX + mvp[4]! * rtcY + mvp[12]!) / cw
    const ndcY = (mvp[1]! * rtcX + mvp[5]! * rtcY + mvp[13]!) / cw
    scratch[0] = (ndcX + 1) * 0.5 * canvasWidth
    scratch[1] = (1 - ndcY) * 0.5 * canvasHeight
    return scratch
  }
}
