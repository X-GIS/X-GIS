// ═══ Map Camera — 줌/패닝/회전/피치 ═══

import { lonLatToMercator } from '../../loader/geojson'
import { mercatorToECEFSphere, ecefToENURotation, type ECEF } from './ecef'
import { WORLD_MERC, TILE_PX } from '../gpu/gpu-shared'
import { getMaxDpr } from '../gpu/gpu'
import { computeLogDepthFc } from '../shaders/log-depth'
import { buildGlobeMatrix } from './globe'
import { mercatorYToLat, mercatorYToLatRad } from './projection'
import { invOrthographic, mulVec4, invert4x4 } from './camera-helpers'

export class Camera {
  /** Camera center in Web Mercator coordinates */
  centerX: number
  centerY: number
  /** Zoom level (0 = whole world, higher = closer) */
  zoom: number
  /** Map rotation in degrees (0 = north up, clockwise positive) */
  bearing = 0
  private _pitch = 0
  /** Set by Map for the FLAT azimuthal projections (orthographic /
   *  azimuthal_equidistant / stereographic): their 2D disc has no
   *  meaningful tilt, so a pitched 2D camera just lays the disc on its
   *  side ("지도가 2D로 눕는다"). While locked, `pitch` reads 0 — every
   *  caller (controller gestures, diagnostics restore, prefetch) is
   *  funnelled through the accessor so none can bypass it. The true 3D
   *  `globe` mode does NOT lock this; it uses a real orbit camera
   *  (projection/globe.ts) where pitch is meaningful. */
  pitchLocked = false
  /** Camera pitch/tilt in degrees (0 = top-down, 85 = nearly horizontal) */
  get pitch(): number { return this.pitchLocked ? 0 : this._pitch }
  set pitch(deg: number) {
    // Reject non-finite (NaN/Infinity) inputs. A pointer event with
    // unexpected values, a deserialized hash with a malformed pitch
    // field, or a buggy diagnostics replay would otherwise let NaN
    // through; the matrix-math downstream propagates NaN to the
    // view-projection and every fragment depth lands as NaN. Keep
    // the previous pitch instead.
    if (!Number.isFinite(deg)) return
    this._pitch = deg
  }

  /** Set by Map for the true 3D `globe` projection (projType 7). When
   *  on, the matrix the renderers consume is the orbit-camera view-proj
   *  (projection/globe.ts) instead of the 2D Mercator-plane MVP — this
   *  is what makes pitch a Cesium-style 3D tilt rather than laying a
   *  flat map on its side. The 2D path below is untouched (guard-claused
   *  in getRTCMatrix / getFrameView) so projType 0..6 stay byte-identical.
   *  NOTE: pan/zoom still mutate centerX/Y/zoom in Mercator terms and
   *  the globe re-derives from them — usable, but true drag-to-rotate /
   *  cursor-anchored globe zoom is the remaining interaction wiring. */
  globeMode = false
  /** When in globeMode, use a parallel (orthographic) orbit-camera
   *  projection instead of the perspective one. Set by the Map for the
   *  azimuthal set (ortho / azimuthal_equidistant / stereographic) so a
   *  tilt is a true orthographic 3D tilt — no perspective foreshortening,
   *  and byte-identical to the flat 2D disc at pitch=0. The true `globe`
   *  leaves this false (keeps its perspective orbit camera). */
  globeOrtho = false
  /** Resolved projection kind (0=mercator … 3=orthographic … 7=globe),
   *  pushed by the Map each frame. zoomAt reads it to choose a
   *  projection-correct cursor anchor — the flat-plane Mercator
   *  unproject is only valid for the cylindrical/pseudocylindrical set;
   *  orthographic needs the spherical inverse so the geographic point
   *  under the fingers stays pinned (Cesium-style) during pinch zoom. */
  projType = 0
  private _globeMatrix = new Float32Array(16)
  /** Upper bound for `zoom`. Set by the Map based on source.maxLevel so
   *  that user pan/zoom input and hash restoration can't push us past the
   *  data's usable range (beyond which tile-local float32 precision and
   *  sub-tile generation cost both blow up). Default 22 = "effectively
   *  unlimited" for high-detail sources. */
  maxZoom = 22

  /** Lower bound for `zoom`. Matches Mapbox spec default of 0 (whole
   *  world view). Hosts can tighten via setMinZoom on XGISMap to prevent
   *  the user zooming out past a desired threshold (e.g. minZoom=8 for a
   *  city-level deployment that should never show a country-wide view). */
  minZoom = 0

  /** Perspective field of view in degrees.
   *  Matches MapLibre's default `_fovInRadians = 0.6435011087932844`
   *  (≈ 36.87°). The earlier 45° was visibly wider than ML at pitched
   *  views: at z=4.96 pitch=45 over Korea, X-GIS rendered up to
   *  Khabarovsk while ML's frustum cut off around Tongliao. Pitch-0
   *  views are FOV-invariant (altitude derives from FOV to fit the
   *  zoom-determined ground viewport), so this change is visually
   *  inert at pitch=0 and tightens horizon parity at pitch>0. */
  static readonly FOV = 0.6435011087932844 * 180 / Math.PI

  constructor(lon = 0, lat = 0, zoom = 2) {
    const [mx, my] = lonLatToMercator(lon, lat)
    this.centerX = mx
    this.centerY = my
    this.zoom = zoom
  }

  /** Get the view-projection matrix as Float32Array (column-major 4x4) */
  getMatrix(canvasWidth: number, canvasHeight: number): Float32Array {
    // Scale: at zoom 0, the whole world (~40M meters) fits in the viewport
    // Each zoom level doubles the scale
    const metersPerPixel = (WORLD_MERC / TILE_PX) / Math.pow(2, this.zoom)
    const scaleX = 2 / (canvasWidth * metersPerPixel)
    const scaleY = 2 / (canvasHeight * metersPerPixel)

    // Translation: move camera center to origin
    const tx = -this.centerX * scaleX
    const ty = -this.centerY * scaleY

    // Column-major 4x4 orthographic matrix
    // prettier-ignore
    return new Float32Array([
      scaleX, 0,      0, 0,
      0,      scaleY, 0, 0,
      0,      0,      1, 0,
      tx,     ty,     0, 1,
    ])
  }

  // Preallocated RTC matrix (reused every frame)
  private rtcMatrix = new Float32Array(16)
  /** Preallocated ECEF-ENU MVP buffer for `getECEFFrameView`. Owns a
   *  separate backing store from `rtcMatrix` (Phase 2 PR 2c.1 architect
   *  P1 #8) so that interleaved getFrameView/getECEFFrameView calls in
   *  the same frame don't overwrite each other. */
  private rtcMatrixECEF = new Float32Array(16)
  /** ECEF-MVP cache shadow (architect P1 #10 — alternative B: separate
   *  cache state). Mirror of the `_cache*` block above; the legacy
   *  matrix cache cannot be re-used because the legacy build path can
   *  hit and return early while the ECEF build still needs to run. */
  private _ecefCacheW = -1
  private _ecefCacheH = -1
  private _ecefCacheDpr = -1
  private _ecefCacheCx = NaN
  private _ecefCacheCy = NaN
  private _ecefCacheZoom = NaN
  private _ecefCacheBearing = NaN
  private _ecefCachePitch = NaN
  private _ecefCacheFar = 0

  // Cache: identical (camera state, viewport, dpr) → reuse rtcMatrix +
  // far instead of rebuilding. Hot for the tile selector which calls
  // unprojectToZ0 SAMPLES_PER_AXIS² (~49) times per frame, each call
  // funneling through here. NaN sentinels guarantee a miss on first
  // call regardless of subsequent inputs.
  private _cacheW = -1
  private _cacheH = -1
  private _cacheDpr = -1
  private _cacheCx = NaN
  private _cacheCy = NaN
  private _cacheZoom = NaN
  private _cacheBearing = NaN
  private _cachePitch = NaN
  private _cacheFar = 0
  private _invDirty = true

  /** Core matrix + far-plane math. Writes the MVP into `this.rtcMatrix`
   *  and returns the far-plane value. Private helper shared by
   *  getRTCMatrix (matrix only) and getFrameView (matrix + far + fc).
   *
   *  `dpr` (device-pixel-ratio) is used ONLY to convert the altitude
   *  term to a CSS-pixel basis. Aspect ratio is `canvasWidth/canvasHeight`
   *  and is DPR-invariant (both scale equally). Altitude derives from
   *  `canvasHeight × mppCSS`, so passing device dims here without `dpr`
   *  would inflate altitude by DPR — the camera would think it's 3× as
   *  far from the ground at DPR=3, ground-plane unprojects would land
   *  in different world positions, and tile-selection would diverge from
   *  what DPR=1 renders. Default `dpr=1` preserves existing test call
   *  sites that pass CSS-equivalent dimensions. */
  private _buildRTCMatrix(canvasWidth: number, canvasHeight: number, dpr: number = 1): number {
    if (
      canvasWidth === this._cacheW &&
      canvasHeight === this._cacheH &&
      dpr === this._cacheDpr &&
      this.centerX === this._cacheCx &&
      this.centerY === this._cacheCy &&
      this.zoom === this._cacheZoom &&
      this.bearing === this._cacheBearing &&
      this.pitch === this._cachePitch
    ) {
      return this._cacheFar
    }
    const metersPerPixel = (WORLD_MERC / TILE_PX) / Math.pow(2, this.zoom)
    const m = this.rtcMatrix

    // ── Always use perspective path (no ortho/perspective discontinuity) ──
    // MVP = Perspective × Translate(0,0,-alt) × RotateX(pitch) × RotateZ(bearing)
    // Applied right-to-left: bearing → pitch → move camera up → project

    const fovRad = Camera.FOV * Math.PI / 180
    const halfFov = fovRad / 2
    const aspect = canvasWidth / canvasHeight
    const pitchRad = this.pitch * Math.PI / 180
    // Mapbox / MapLibre convention: `bearing=90` makes the map face
    // east, so `RotateZ(+bearing)` is the world→camera transform that
    // brings east into camera-forward. X-GIS previously used
    // `-bearing` here, which inverted the rotation direction relative
    // to MapLibre — visible as bearing=90 facing west instead of east
    // when compared side-by-side. The pan handler below uses the
    // same convention (`+bearing` rotates screen-space input into
    // world-space delta) so drag direction stays consistent after
    // the sign fix.
    const bearingRad = this.bearing * Math.PI / 180

    // Camera altitude in Mercator meters — based on the CSS-pixel
    // viewport height. Tying it to the device-pixel `canvasHeight`
    // would make the altitude (and thus the entire MVP) DPR-dependent,
    // breaking the "same camera = same world view at any DPR"
    // contract that tile selection relies on.
    const viewHeightMeters = (canvasHeight / dpr) * metersPerPixel
    const altitude = viewHeightMeters / 2 / Math.tan(halfFov)

    // Near/far planes: cover all visible ground including horizon
    // maxViewAngle = angle from vertical to the top of the screen ray
    // When pitch + halfFov >= 90°, the top of the screen is past the horizon
    const maxViewAngle = Math.min(pitchRad + halfFov, Math.PI / 2 - 0.01)
    const farthestGround = altitude / Math.cos(maxViewAngle)
    // Near plane: 1% of altitude, but never smaller than 1 m. Log-depth
    // preserves precision at any near/far ratio, so the tiny floor only
    // protects against primitive clipping when the camera dips below ~1 m
    // above the ground (zoom ~22 + pitch 0).
    const near = Math.max(1.0, altitude * 0.01)
    const far = farthestGround * 1.5

    // Multiply two column-major 4×4 matrices into `out` array
    const mul4 = (out: number[], a: number[], b: number[]) => {
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) {
          let s = 0
          for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
          out[c * 4 + r] = s
        }
    }

    // Perspective matrix (column-major)
    const f = 1 / Math.tan(halfFov)
    const nf = 1 / (near - far)
    const P = [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]

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
    const t1 = Camera._t1, t2 = Camera._t2
    mul4(t1, Rx, Rz)      // t1 = Rx × Rz
    mul4(t2, T, t1)        // t2 = T × (Rx × Rz)
    mul4(Camera._t3, P, t2) // t3 = P × T × Rx × Rz

    for (let i = 0; i < 16; i++) m[i] = Camera._t3[i]
    this._cacheW = canvasWidth
    this._cacheH = canvasHeight
    this._cacheDpr = dpr
    this._cacheCx = this.centerX
    this._cacheCy = this.centerY
    this._cacheZoom = this.zoom
    this._cacheBearing = this.bearing
    this._cachePitch = this.pitch
    this._cacheFar = far
    this._invDirty = true
    this._mvpGeneration++
    return far
  }
  /** iter-189 — bumps every time `_buildRTCMatrix` reseats the
   *  matrix. Used by `getVisibleWorldCopies` to identify a stable
   *  per-frame matrix and skip the four-corner unproject when the
   *  camera hasn't moved. */
  private _mvpGeneration = 0

  /** Globe orbit view-projection (RTC, focus-relative) from the current
   *  camera state. centerLon/Lat are the Mercator-inverse of centerX/Y
   *  so existing pan/zoom (which move centerX/Y) recenter the globe. */
  private _globeFrame(canvasWidth: number, canvasHeight: number, dpr: number): { matrix: Float32Array; far: number } {
    const R = 6378137
    const lon = this.centerX / R * (180 / Math.PI)
    const lat = mercatorYToLat(this.centerY)
    const v = buildGlobeMatrix(
      lon, lat, this.zoom, this.pitch, this.bearing,
      canvasWidth / dpr, canvasHeight / dpr,
      this.globeOrtho,
    )
    this._globeMatrix.set(v.rtcMatrix)
    return { matrix: this._globeMatrix, far: v.far }
  }

  /** Camera anchor in ECEF (Earth-Centered Earth-Fixed) Cartesian metres.
   *
   *  Phase 2 ECEF vertex pipeline scaffolding. The canonical camera position
   *  remains the Mercator-metre pair `centerX, centerY` — every pan/zoom/
   *  hash-restore/interaction site reads those directly and stays untouched
   *  by the ECEF migration. ECEF is derived at matrix-build time only,
   *  never cached on the class.
   *
   *  Consumed by Phase 2 PR 2c+ shader paths that switch the polygon /
   *  line / point / raster / text VSes from Mercator-vertex + per-vertex
   *  `project_geom` to ECEF-vertex + linear `mvp * vec4(ecef_rtc, 1)`.
   *
   *  Uses the **sphere** variant (radius A, E2=0) so the ECEF basis matches
   *  the legacy spherical-Mercator MVP basis used by `_buildRTCMatrix`
   *  (`WORLD_MERC = 2π × A`). Building on the WGS84 ellipsoid would
   *  introduce a 0.67 % north-axis compression that breaks the dual-path
   *  parity gate at lat=0. See `lonLatToECEFSphere` for the full rationale. */
  getECEFCenter(): ECEF {
    return mercatorToECEFSphere(this.centerX, this.centerY)
  }

  /** ECEF→ENU (East/North/Up) tangent-plane rotation at the camera anchor.
   *
   *  Column-major Float32Array(16) with identity in the homogeneous row/
   *  column. Used by Phase 2 PR 2c+ shader paths to compose the legacy
   *  Mercator-perspective MVP with the ECEF basis swap:
   *
   *    ecef_rtc = ecef_vertex - getECEFCenter()
   *    enu_xyz  = ecefToENURotation(cam_lon, cam_lat) * ecef_rtc
   *    clip     = existing_perspective_mvp * vec4(enu_xyz, 1)
   *
   *  The ENU basis at the camera anchor agrees with the local Mercator-
   *  metre basis to within tangent-plane curvature error — sub-mm at z=18
   *  city scale, ≤ 0.5% pixel-delta on Mercator fixtures at world scale.
   *  This satisfies AC2.1 of the Phase 2 plan without requiring the
   *  legacy `getRTCMatrix` to be rewritten in PR 2b (PR 2c is the first
   *  consumer). */
  getECEFToENURotation(): Float32Array {
    // Derive the camera lon/lat from the canonical Mercator-metre anchor.
    // Mirrors the existing inverse-Mercator formula used elsewhere in this
    // module (e.g. `projection.ts:mercatorYToLatRad`); kept inline so the
    // helper does not pull in the heavier projection import surface.
    const EARTH_R = 6378137
    const RAD2DEG = 180 / Math.PI
    const lon = (this.centerX / EARTH_R) * RAD2DEG
    const lat = (2 * Math.atan(Math.exp(this.centerY / EARTH_R)) - Math.PI / 2) * RAD2DEG
    return ecefToENURotation(lon, lat)
  }

  /** RTC matrix: perspective projection × view (pitch + bearing).
   *  When pitch=0, reduces to the same orthographic-like result as before.
   *  Discards the far-plane value — use getFrameView() when you also
   *  need far / log-depth. */
  getRTCMatrix(canvasWidth: number, canvasHeight: number, dpr: number = 1): Float32Array {
    if (this.globeMode) return this._globeFrame(canvasWidth, canvasHeight, dpr).matrix
    this._buildRTCMatrix(canvasWidth, canvasHeight, dpr)
    return this.rtcMatrix
  }

  /** iter-286 — diagnostic snapshot of the resolved camera state for
   *  the current viewport. Captures the derived numbers (altitude,
   *  near, far, halfFov, pitch, bearing) that the matrix construction
   *  inside `_buildRTCMatrix` consumes, plus the resulting RTC matrix
   *  as a flat 16-tuple. Probe-first guidance from memory entries
   *  `project_mercator_z0_pitch_render` + `project_non_merc_z0_disc_
   *  render_fail`: blind-patching camera.ts has historically flipped
   *  failure modes; the only viable change cycle is matrix-dump-diff
   *  vs known-good cells first, code change second.
   *
   *  Independent of `getFrameView` — pure read, no mutation of the
   *  cached matrix beyond the standard `_buildRTCMatrix` call that
   *  every render path already issues. */
  getDebugSnapshot(canvasWidth: number, canvasHeight: number, dpr: number = 1): {
    matrix: number[]
    far: number
    altitude: number
    halfFovRad: number
    pitchDeg: number
    bearingDeg: number
    zoom: number
    canvasW: number
    canvasH: number
    dpr: number
  } {
    const far = this._buildRTCMatrix(canvasWidth, canvasHeight, dpr)
    // iter-338 — report the ACTUAL matrix the renderer uses: in globe
    // mode that's the orbit-camera `_globeFrame`, not the Mercator RTC.
    // Without this the snapshot (and any continuity gate built on it)
    // silently tracked the wrong matrix in globe mode.
    const matrix = this.globeMode
      ? Array.from(this._globeFrame(canvasWidth, canvasHeight, dpr).matrix)
      : Array.from(this.rtcMatrix)
    // Recompute altitude + halfFov from the same inputs the build
    // method uses; avoids exposing a private field. `metersPerPixel`
    // mirrors the build's local — kept in sync via comment if either
    // ever changes shape.
    const metersPerPixel = (WORLD_MERC / TILE_PX) / Math.pow(2, this.zoom)
    const halfFovRad = (Camera.FOV * Math.PI / 180) / 2
    const viewHeightMeters = (canvasHeight / dpr) * metersPerPixel
    const altitude = viewHeightMeters / 2 / Math.tan(halfFovRad)
    return {
      matrix,
      far,
      altitude,
      halfFovRad,
      pitchDeg: this.pitch,
      bearingDeg: this.bearing,
      zoom: this.zoom,
      canvasW: canvasWidth,
      canvasH: canvasHeight,
      dpr,
    }
  }

  /** Build the matrix + far + log-depth factor in a single call. No hidden
   *  state — callers get the far value directly and pass it to whatever
   *  uniform or shader needs it.
   *
   *  Note: `matrix` is a reference to the camera's preallocated
   *  `rtcMatrix` buffer (shared with getRTCMatrix). Copy the contents
   *  into your own uniform immediately; a subsequent call from the same
   *  camera overwrites this buffer. */
  getFrameView(canvasWidth: number, canvasHeight: number, dpr: number = 1): {
    matrix: Float32Array
    far: number
    logDepthFc: number
  } {
    if (this.globeMode) {
      const g = this._globeFrame(canvasWidth, canvasHeight, dpr)
      return { matrix: g.matrix, far: g.far, logDepthFc: computeLogDepthFc(g.far) }
    }
    const far = this._buildRTCMatrix(canvasWidth, canvasHeight, dpr)
    return { matrix: this.rtcMatrix, far, logDepthFc: computeLogDepthFc(far) }
  }

  /** ECEF-MVP for the polygon ECEF pipeline (Phase 2 PR 2c.1).
   *
   *  Built in true-ENU-metre semantics:
   *    altitude_true = altitude_mercator × cos(cam_lat)
   *    mpp_true      = mpp_mercator × cos(cam_lat)
   *  Composes with `ecefToENURotation(cam_lon, cam_lat)` so vertices
   *  expressed in ECEF-RTC (relative to the camera ECEF anchor) project
   *  correctly: `clip = mvp_ecef × vec4(ecef_rtc, 1)`.
   *
   *  Math:
   *    mvp_ecef = perspective(fov, aspect, near, far)
   *             × translate(0, 0, -altitude_true)
   *             × rotateX(-pitch)
   *             × rotateZ(bearing)
   *             × ecefToENURotation(cam_lon, cam_lat)
   *
   *  Why the cos(lat) factor: legacy `_buildRTCMatrix` is built in
   *  Mercator-metre semantics (`metersPerPixel = WORLD_MERC/TILE_PX/2^z`
   *  is Mercator metres per pixel). At latitude φ, one Mercator metre of
   *  east-west extent equals cos(φ) true east-west metres. ENU output is
   *  in true metres. Without the cos(lat) altitude correction, polygons
   *  would render cos(lat) smaller than legacy paths — a 30 % shrink at
   *  lat=45°, 91 % at lat=85°. Applying cos(lat) on the CPU here moves
   *  the basis conversion to the camera side where lat is known cheaply.
   *
   *  CRITICAL: returns reference to the preallocated `rtcMatrixECEF`
   *  buffer (separate from `rtcMatrix` used by `getFrameView`). Copy
   *  contents into your own uniform immediately — a subsequent
   *  `getECEFFrameView` call from the same camera overwrites this buffer.
   *
   *  Globe-mode: bypasses to existing `_globeFrame` (orbit camera owns
   *  its own math; ECEF migration deferred to a later sub-PR).
   *
   *  Cache: separate `_ecefCache*` shadow (architect P1 #10 alt-B). */
  getECEFFrameView(canvasWidth: number, canvasHeight: number, dpr: number = 1): {
    matrix: Float32Array
    far: number
    logDepthFc: number
  } {
    if (this.globeMode) {
      const g = this._globeFrame(canvasWidth, canvasHeight, dpr)
      return { matrix: g.matrix, far: g.far, logDepthFc: computeLogDepthFc(g.far) }
    }
    if (
      canvasWidth === this._ecefCacheW &&
      canvasHeight === this._ecefCacheH &&
      dpr === this._ecefCacheDpr &&
      this.centerX === this._ecefCacheCx &&
      this.centerY === this._ecefCacheCy &&
      this.zoom === this._ecefCacheZoom &&
      this.bearing === this._ecefCacheBearing &&
      this.pitch === this._ecefCachePitch
    ) {
      const cachedFar = this._ecefCacheFar
      return {
        matrix: this.rtcMatrixECEF,
        far: cachedFar,
        logDepthFc: computeLogDepthFc(cachedFar),
      }
    }

    // 1. cam_lon, cam_lat from canonical Mercator centerX/centerY.
    const EARTH_R = 6378137
    const RAD2DEG = 180 / Math.PI
    const cam_lon = (this.centerX / EARTH_R) * RAD2DEG
    const cam_lat = (2 * Math.atan(Math.exp(this.centerY / EARTH_R)) - Math.PI / 2) * RAD2DEG
    const cos_lat = Math.cos(cam_lat * Math.PI / 180)

    // 2. mpp/altitude in TRUE ENU metres.
    const mpp_mercator = (WORLD_MERC / TILE_PX) / Math.pow(2, this.zoom)
    const mpp_true = mpp_mercator * cos_lat
    const viewHeightTrueM = (canvasHeight / dpr) * mpp_true

    // 3. FOV / aspect / pitch / bearing — identical to legacy build.
    const fovRad = Camera.FOV * Math.PI / 180
    const halfFov = fovRad / 2
    const aspect = canvasWidth / canvasHeight
    const pitchRad = this.pitch * Math.PI / 180
    const bearingRad = this.bearing * Math.PI / 180

    // 4. Altitude in true metres + near/far via the legacy formula.
    const altitude_true = viewHeightTrueM / 2 / Math.tan(halfFov)
    const maxViewAngle = Math.min(pitchRad + halfFov, Math.PI / 2 - 0.01)
    const farthestGround = altitude_true / Math.cos(maxViewAngle)
    const near = Math.max(1.0, altitude_true * 0.01)
    const far = farthestGround * 1.5

    // 5. Build the 4×4 chain. Mirrors `_buildRTCMatrix:207-258` structure
    //    but with `altitude_true` and an extra post-multiplied rotation.
    const mul4 = (out: number[], a: number[], b: number[]) => {
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) {
          let s = 0
          for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
          out[c * 4 + r] = s
        }
    }

    // Perspective (column-major).
    const f = 1 / Math.tan(halfFov)
    const nf = 1 / (near - far)
    const P = [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]
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
    const t1 = Camera._t1, t2 = Camera._t2, t3 = Camera._t3
    mul4(t1, Rx, Rz)          // t1 = Rx × Rz
    mul4(t2, t1, Renu)         // t2 = Rx × Rz × Renu
    mul4(t1, T, t2)            // t1 = T × Rx × Rz × Renu
    mul4(t3, P, t1)            // t3 = P × T × Rx × Rz × Renu

    const m = this.rtcMatrixECEF
    for (let i = 0; i < 16; i++) m[i] = t3[i]

    this._ecefCacheW = canvasWidth
    this._ecefCacheH = canvasHeight
    this._ecefCacheDpr = dpr
    this._ecefCacheCx = this.centerX
    this._ecefCacheCy = this.centerY
    this._ecefCacheZoom = this.zoom
    this._ecefCacheBearing = this.bearing
    this._ecefCachePitch = this.pitch
    this._ecefCacheFar = far

    return { matrix: m, far, logDepthFc: computeLogDepthFc(far) }
  }

  // Mercator Y limit: ±85.051129° → ±20037508.34m
  private static readonly MAX_Y = 20037508.34
  private static _t1 = new Array(16).fill(0)
  private static _t2 = new Array(16).fill(0)
  private static _t3 = new Array(16).fill(0)

  // ── MVP Inverse (for screen → world unprojection) ──
  private rtcMatrixInv = new Float32Array(16)

  /** Get the inverse of the RTC matrix (cached per frame). The MVP cache
   *  in `_buildRTCMatrix` flips `_invDirty` only when the matrix actually
   *  changes; while the matrix is stable (e.g. across the 49 tile-selector
   *  unproject calls of a single frame) we skip the invert4x4 entirely. */
  getRTCMatrixInverse(canvasWidth: number, canvasHeight: number, dpr: number = 1): Float32Array {
    this._buildRTCMatrix(canvasWidth, canvasHeight, dpr)
    if (this._invDirty) {
      invert4x4(this.rtcMatrix, this.rtcMatrixInv)
      this._invDirty = false
    }
    return this.rtcMatrixInv
  }

  /** Unproject screen pixel to z=0 world plane (RTC-relative).
   *  Returns [x, y] in projection meters relative to camera center, or null if behind horizon. */
  unprojectToZ0(screenX: number, screenY: number, canvasWidth: number, canvasHeight: number, dpr: number = 1): [number, number] | null {
    const inv = this.getRTCMatrixInverse(canvasWidth, canvasHeight, dpr)
    const ndcX = (screenX / canvasWidth) * 2 - 1
    const ndcY = 1 - (screenY / canvasHeight) * 2

    // Ray from near to far plane
    const n = mulVec4(inv, [ndcX, ndcY, -1, 1])
    const f = mulVec4(inv, [ndcX, ndcY, 1, 1])
    // Perspective divide
    const nx = n[0] / n[3], ny = n[1] / n[3], nz = n[2] / n[3]
    const fx = f[0] / f[3], fy = f[1] / f[3], fz = f[2] / f[3]

    // Intersect with z=0 plane
    const dz = fz - nz
    if (Math.abs(dz) < 1e-10) return null
    const t = -nz / dz
    if (t < 0) return null // behind camera

    return [nx + t * (fx - nx), ny + t * (fy - ny)]
  }

  /** iter-189 — world-copy root fix. Single source of truth for
   *  "which world copies are visible this frame", consumed by every
   *  CPU-projected path (labels, raster tile draw, point markers,
   *  overlays). Replaces the four+ inlined `[0, -1, 1, -2, 2]`
   *  enumerations that diverged whenever a new renderer landed
   *  (iter-188 found two with a hardcoded `break` after the first
   *  copy that fit).
   *
   *  Algorithm: unproject the four NDC corners to the z=0 plane,
   *  add the camera centre to recover absolute Mercator x, convert
   *  to longitude, then enumerate integer 360°-offsets that fall
   *  inside `[minLon, maxLon]`. Clamped to ±2 worlds since the
   *  polygon vertex shader's WORLD_COPIES constant pins that ceiling.
   *
   *  Non-Mercator + globe modes collapse to `[0]` — there is no
   *  cylindrical world wrap to enumerate. */
  private _vwcMatrixId = -1
  private _vwcCached: readonly number[] = [0]
  getVisibleWorldCopies(canvasWidth: number, canvasHeight: number, dpr: number = 1): readonly number[] {
    if (this.globeMode || this.projType !== 0) return [0]
    // Build matrix (also bumps `_invDirty` when matrix changed). Use
    // the post-build _invDirty flag as a "matrix identity" hash for
    // the cache — if invert state is fresh, the matrix is fresh too,
    // and the corner unprojections are stable to re-use.
    this._buildRTCMatrix(canvasWidth, canvasHeight, dpr)
    const matrixId = this._mvpGeneration
    if (matrixId === this._vwcMatrixId) return this._vwcCached
    // Unproject the four canvas corners to z=0 plane. Mid-edge
    // samples help when extreme pitch makes the canvas corners
    // project behind-camera (returns null) — at least one mid-edge
    // usually still hits the ground plane.
    const w = canvasWidth, h = canvasHeight
    const samples: Array<[number, number] | null> = [
      this.unprojectToZ0(0, 0, w, h, dpr),
      this.unprojectToZ0(w, 0, w, h, dpr),
      this.unprojectToZ0(w, h, w, h, dpr),
      this.unprojectToZ0(0, h, w, h, dpr),
      this.unprojectToZ0(w / 2, 0, w, h, dpr),
      this.unprojectToZ0(w / 2, h, w, h, dpr),
      this.unprojectToZ0(0, h / 2, w, h, dpr),
      this.unprojectToZ0(w, h / 2, w, h, dpr),
      this.unprojectToZ0(w / 2, h / 2, w, h, dpr),
    ]
    const R = 6378137
    const DEG_PER_M = 180 / Math.PI / R
    let lonMin = Infinity, lonMax = -Infinity
    for (const s of samples) {
      if (!s) continue
      const absMercX = s[0] + this.centerX
      const lon = absMercX * DEG_PER_M
      if (lon < lonMin) lonMin = lon
      if (lon > lonMax) lonMax = lon
    }
    if (!Number.isFinite(lonMin) || !Number.isFinite(lonMax)) {
      this._vwcCached = [0]
      this._vwcMatrixId = matrixId
      return this._vwcCached
    }
    // Convert lon range to world-offset range. Offset N corresponds
    // to lon range [N*360 - 180, N*360 + 180]. So a sample at
    // lon=540° is in world copy +1 (since 540 = 360 + 180). The
    // offset for a given lon is `Math.round(lon / 360)`.
    const woMin = Math.max(-2, Math.floor((lonMin + 180) / 360))
    const woMax = Math.min(2, Math.ceil((lonMax - 180) / 360))
    const out: number[] = []
    for (let wo = woMin; wo <= woMax; wo++) out.push(wo)
    // Always include 0 — non-degenerate visible camera should see
    // the primary copy at minimum. Defensive guard for tiny
    // viewports / extreme zoom where the lon range collapses inside
    // one copy and the floor/ceil arithmetic returns an empty range.
    if (out.length === 0 || (!out.includes(0) && Math.abs(woMin) <= 2 && Math.abs(woMax) <= 2)) {
      if (!out.includes(0)) out.push(0)
    }
    this._vwcCached = out
    this._vwcMatrixId = matrixId
    return this._vwcCached
  }

  /** Compute the maximum camera Y offset for the current zoom (content stays on screen) */
  private maxCameraY(canvasHeight: number): number {
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
    const metersPerPixel = (WORLD_MERC / TILE_PX) / Math.pow(2, this.zoom)
    const visibleHalf = (canvasHeight / dpr) * metersPerPixel / 2
    // Camera can move until the Mercator edge reaches the screen edge
    return Math.max(0, Camera.MAX_Y - visibleHalf)
  }

  /** Pan by CSS pixels (clientX/clientY delta), accounting for map rotation */
  pan(dx: number, dy: number, _canvasWidth: number, canvasHeight: number): void {
    if (this.globeMode) {
      // Globe: drag rotates the sphere (content follows the cursor).
      // Pixel delta → lon/lat at the same per-pixel feel as the 2D map
      // (meters-per-pixel converted to degrees on the surface), bearing-
      // rotated. Not a pixel-exact arcball, but Cesium-style drag-to-
      // rotate; centerX/Y stay Mercator so the rest of the camera and
      // tile selection keep working unchanged.
      const R = 6378137
      const mpp = (WORLD_MERC / TILE_PX) / Math.pow(2, this.zoom)
      const rb = this.bearing * Math.PI / 180
      const cb = Math.cos(rb), sb = Math.sin(rb)
      const gdx = dx * cb + dy * sb
      const gdy = -dx * sb + dy * cb
      const degPerPx = (mpp / R) * (180 / Math.PI)
      let lon = this.centerX / R * (180 / Math.PI) - gdx * degPerPx
      let lat = mercatorYToLat(this.centerY) + gdy * degPerPx
      lat = Math.max(-85.051129, Math.min(85.051129, lat))
      lon = ((lon + 180) % 360 + 360) % 360 - 180
      this.centerX = lon * (Math.PI / 180) * R
      this.centerY = Math.log(Math.tan(Math.PI / 4 + lat * (Math.PI / 180) / 2)) * R
      return
    }
    // mpp from the formula `WORLD_MERC / TILE_PX / 2^zoom` is meters per
    // CSS pixel — the Mapbox / MapLibre tile-pyramid convention
    // (TILE_PX = 512). A given numeric `zoom` produces the same m/px
    // X-GIS and MapLibre, so hash URLs transfer between the two
    // engines without visual drift. After the MVP
    // DPR-invariance fix (ee1f394), 1 input CSS pixel of drag maps
    // directly to `mpp` meters of world motion at any DPR. The prior
    // `× dpr` factor was needed for the old DPR-dependent altitude
    // semantic (1 CSS px = mpp × dpr m); leaving it in now would make
    // the map pan DPR× too fast — symptom: the user-reported "pan
    // feels DPR× more sensitive" on a DPR=3 phone.
    const metersPerInputPixel = (WORLD_MERC / TILE_PX) / Math.pow(2, this.zoom)

    // Rotate screen delta by bearing to get map-space delta
    const rad = this.bearing * Math.PI / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const mapDx = dx * cos + dy * sin
    const mapDy = -dx * sin + dy * cos

    this.centerX -= mapDx * metersPerInputPixel
    // Wrap X to stay within one world width (prevents infinite drift)
    const halfWorld = WORLD_MERC / 2
    if (this.centerX > halfWorld) this.centerX -= WORLD_MERC
    else if (this.centerX < -halfWorld) this.centerX += WORLD_MERC
    const maxY = this.maxCameraY(canvasHeight)
    const newY = this.centerY + mapDy * metersPerInputPixel
    this.centerY = Math.max(-maxY, Math.min(maxY, newY))
  }

  /** Rotate by delta degrees */
  rotate(deltaDeg: number): void {
    this.bearing = ((this.bearing + deltaDeg) % 360 + 360) % 360
  }

  /** Reset bearing to north-up */
  resetBearing(): void {
    this.bearing = 0
  }

  /** Zoom by delta at CSS screen position (clientX/clientY).
   *
   *  Anchors the world point under the cursor: unproject the cursor
   *  via the BEFORE-zoom MVP (gets the world location it points at),
   *  apply the zoom delta, then re-unproject at the same cursor and
   *  shift `centerX/Y` by the difference so that same world point
   *  sits under the cursor again. Works at any pitch and bearing
   *  because unprojectToZ0 walks the full MVP — the previous
   *  implementation only handled pitch=0 + bearing=0 (offset
   *  computed in raw screen coords without the bearing rotation
   *  that `pan()` already applies). */
  zoomAt(delta: number, screenX: number, screenY: number, canvasWidth: number, canvasHeight: number): void {
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
    // unprojectToZ0 takes DEVICE-pixel screen coords (it scales by
    // canvasWidth which is device-px). Convert CSS clientX/Y → device.
    const sxDev = screenX * dpr
    const syDev = screenY * dpr

    // World point under cursor BEFORE zoom — relative to current
    // camera (rel coords). For orthographic these are points on the
    // azimuthal DISC plane (RTC, projection-centre-relative), NOT the
    // Mercator plane, so the Mercator-meter centre shift below would be
    // wrong-scale and fling the globe off-screen on every pinch step
    // (reported as "orthographic pinch zoom doesn't work"). The
    // orthographic branch instead pins the GEOGRAPHIC point under the
    // fingers (Cesium-style) by inverse-projecting it through the disc.
    const before = this.unprojectToZ0(sxDev, syDev, canvasWidth, canvasHeight, dpr)

    if (this.projType === 3 && !this.globeMode) {
      const R = 6378137
      // Only geo-anchor when the fingers are solidly on the visible
      // hemisphere. Near the limb (|q| → R) the orthographic inverse is
      // singular: a sub-pixel screen move maps to a huge lon/lat swing,
      // so anchoring there flings the globe ~tens of degrees per step
      // (the "still doesn't work on mobile" case — the pinch midpoint is
      // rarely dead-centre on the disc). Off the disc / near the limb we
      // fall back to a plain centre-anchored scale, which is exactly how
      // Cesium behaves when you pinch on empty space beside the globe.
      const DISC_SAFE = 0.85 * R
      const onDisc = (p: [number, number] | null): boolean =>
        !!p && Math.hypot(p[0], p[1]) < DISC_SAFE

      const lon0 = this.centerX / R
      const lat0 = mercatorYToLatRad(this.centerY)
      const anchor = onDisc(before) ? invOrthographic(before![0], before![1], lon0, lat0) : null

      this.zoom = Math.max(0, Math.min(this.maxZoom, this.zoom + delta))

      if (anchor) {
        // Same screen point, new zoom, UNCHANGED centre → the disc
        // scaled about the projection centre so a different geographic
        // point now sits under the fingers. Rotate the globe by that
        // geographic difference so the originally-touched point returns
        // under the fingers. Pinch streams many small deltas, so the
        // local-linear residual self-corrects across the gesture.
        const q = this.unprojectToZ0(sxDev, syDev, canvasWidth, canvasHeight, dpr)
        const cur = onDisc(q) ? invOrthographic(q![0], q![1], lon0, lat0) : null
        if (cur) {
          // Clamp the per-call rotation. A legitimate pinch step nudges
          // the centre by a fraction of a degree; anything larger is a
          // numerical spike from the still-nonlinear inverse and must
          // not be allowed to fling the globe.
          const STEP_LIM = 0.12 // rad ≈ 6.9° — invisibly large for real pinch
          const clamp = (v: number) => Math.max(-STEP_LIM, Math.min(STEP_LIM, v))
          let newLon = lon0 + clamp(anchor[0] - cur[0])
          // Mercator-finite latitude bound — matches the Map's per-frame
          // centerLat clamp so centerY stays representable.
          const LAT_LIM = 85.051129 * Math.PI / 180
          const newLat = Math.max(-LAT_LIM, Math.min(LAT_LIM, lat0 + clamp(anchor[1] - cur[1])))
          // Wrap longitude to (-π, π].
          newLon = ((newLon + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
          this.centerX = newLon * R
          this.centerY = R * Math.log(Math.tan(Math.PI / 4 + newLat / 2))
        }
      }
      const maxYO = this.maxCameraY(canvasHeight)
      this.centerY = Math.max(-maxYO, Math.min(maxYO, this.centerY))
      return
    }

    // Apply zoom; this also invalidates the MVP cache so the next
    // unproject below rebuilds against the new MPP.
    this.zoom = Math.max(0, Math.min(this.maxZoom, this.zoom + delta))

    // World point under cursor AFTER zoom (camera not yet shifted).
    const after = this.unprojectToZ0(sxDev, syDev, canvasWidth, canvasHeight, dpr)

    // Shift centre so the BEFORE world point is under the cursor again.
    // before & after may be null if the cursor ray missed the ground
    // plane (high pitch, cursor above horizon) — then leave centre as
    // is, the zoom still applied around (0,0)-relative.
    if (before && after) {
      this.centerX += before[0] - after[0]
      this.centerY += before[1] - after[1]
      // Wrap X to stay within one world width (mirrors pan()).
      const halfWorld = WORLD_MERC / 2
      if (this.centerX > halfWorld) this.centerX -= WORLD_MERC
      else if (this.centerX < -halfWorld) this.centerX += WORLD_MERC
    }

    // Clamp after zoom: visible area changes with zoom level.
    const maxY = this.maxCameraY(canvasHeight)
    this.centerY = Math.max(-maxY, Math.min(maxY, this.centerY))
  }

  /** Pan the camera so the world point captured at drag start stays
   *  under the cursor as the cursor moves.
   *
   *  CRITICAL: `anchorWorldX/Y` must be ABSOLUTE world (mercator
   *  metres), not camera-relative — i.e. the controller computed it
   *  ONCE at drag start as `centerX_at_start + unprojectToZ0(...)`
   *  and stashed THAT. Each pointermove this method recomputes
   *  cursor_rel against the LIVE MVP and assigns
   *  `centerX = anchorWorldX - cursor_rel.x` directly.
   *
   *  Why absolute: as the camera moves on each pointermove, a
   *  camera-relative anchor goes stale (it was relative to the
   *  ORIGINAL camera position) and produces a residual delta on
   *  every move — visible as runaway accumulating motion in the
   *  wrong direction. Absolute world coords + direct assignment
   *  is idempotent: if the cursor returns to its starting screen
   *  position the camera returns to its starting world position.
   *
   *  Equivalent to old delta-based `pan()` at pitch=0 + bearing=0;
   *  correct under any pitch / bearing because the unprojection walks
   *  the live MVP. */
  panToScreenAnchor(
    anchorWorldX: number, anchorWorldY: number,
    cursorX: number, cursorY: number,
    canvasWidth: number, canvasHeight: number,
  ): void {
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
    const cur = this.unprojectToZ0(cursorX * dpr, cursorY * dpr, canvasWidth, canvasHeight, dpr)
    if (!cur) return // ray missed ground (above horizon) — leave camera as-is
    this.centerX = anchorWorldX - cur[0]
    this.centerY = anchorWorldY - cur[1]
    const halfWorld = WORLD_MERC / 2
    if (this.centerX > halfWorld) this.centerX -= WORLD_MERC
    else if (this.centerX < -halfWorld) this.centerX += WORLD_MERC
    const maxY = this.maxCameraY(canvasHeight)
    this.centerY = Math.max(-maxY, Math.min(maxY, this.centerY))
  }
}
