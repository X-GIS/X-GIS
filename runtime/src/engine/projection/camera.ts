// ═══ Map Camera — 줌/패닝/회전/피치 ═══

import { lonLatToMercator } from '../../loader/geojson'
import { type ECEF } from './ecef'
import { WORLD_MERC, TILE_PX } from '../gpu/gpu-shared'
import { getMaxDpr } from '../gpu/gpu'
import { computeLogDepthFc } from '../shaders/log-depth'
import { EARTH_R } from './globe'
import { mercatorYToLat, mercatorYToLatRad, mercator } from './projection'
import { isGlobeProj, flatViewHeightCapM, worldCopiesFor, enumerateWorldCopies, poleLimit, promotesToGlobeWhenTilted, representsCenterAs } from './projections-table'
import { discAnchorFor, invert4x4, convergeFlatAnchor } from './camera-helpers'
import {
  type CameraView,
  buildRTCMatrix,
  buildGlobeFrame,
  buildECEFFrameView,
  ecefCenterOf,
  ecefToENUOf,
} from './view-matrix'
import {
  unprojectToZ0 as unprojectToZ0Pure,
  unprojectToLonLat as unprojectToLonLatPure,
  unprojectToMercatorAnchor as unprojectToMercatorAnchorPure,
  relToLonLat as relToLonLatPure,
} from './unproject'
import { zoomAtGlobeAnchored, panGlobeToScreenAnchor } from './globe-anchor'

export class Camera {
  /** Camera center in Web Mercator coordinates */
  centerX: number
  centerY: number
  /** TRUE centre latitude in degrees, clamped to `poleLimit(projType)`.
   *  INVARIANT: for any centre with |lat| <= 85.051129 (all cylindrical
   *  projections, and globe away from the pole) `centerLatDeg ===
   *  mercatorYToLat(centerY)` EXACTLY — so this field is byte-identical to the
   *  Mercator-derived latitude everywhere except a sphere camera placed past
   *  85.05. Only `setCenter` RELAXES past 85.05 (static reach-the-pole); the
   *  globe-anchor readers (_globeFrame / getECEFCenter / getECEFToENURotation)
   *  read THIS instead of inverting the Mercator-bounded centerY, letting the
   *  globe orbit reach the pole. Interactive drag/pinch keep their ±85.05 lat
   *  clamp but MUST keep this field synced so it never goes stale. */
  centerLatDeg: number
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
   *  Globe-mode input anchors route through globe-anchor.ts (ray↔sphere). */
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
  /** The SOURCE azimuthal projType (3 ortho / 4 azimuthal_eq / 5 stereo)
   *  before the pitch>0 promotion to the globe path (projType 7). `projType`
   *  above is overwritten to 7 when an azimuthal disc tilts, so it can no
   *  longer tell ortho from azi/stereo — but the globeOrtho framing needs the
   *  per-projType flat view-height cap (flatViewHeightCapM) to keep the disc
   *  the SAME on-screen scale across the pitch=0 boundary. Set by the render
   *  loop each frame; read ONLY by `_globeFrame` in the globeOrtho branch, so
   *  the true perspective globe (projType 7, globeOrtho=false) is unaffected. */
  azimuthalProjType = 0
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
    this.centerLatDeg = mercatorYToLat(my)
    this.zoom = zoom
  }

  /** Resync centerLatDeg from the Mercator centerY. Call after any centerY
   *  write that establishes a |lat|<=85.051129 centre (drag/pinch/pan/clamp);
   *  setCenter writes centerLatDeg directly and may exceed 85.05 on a sphere. */
  private _syncCenterLatFromMercator(): void {
    this.centerLatDeg = mercatorYToLat(this.centerY)
  }

  /** After a zoom (which must NOT move the centre latitude on its own),
   *  carry centerLatDeg by the SAME delta the Mercator centerY moved, so a
   *  pole-ward centre (centerLatDeg > 85.05, centerY saturated) is preserved
   *  through zoom instead of being reset to the Mercator limit. Clamped to the
   *  projection's pole limit. For cylindrical projections latPreserve ===
   *  mercLatPreserve (the invariant), so this collapses to
   *  centerLatDeg = mercatorYToLat(centerY) — byte-identical to the old reset. */
  private _carryCenterLatThroughZoom(latPreserve: number, mercLatPreserve: number): void {
    const delta = mercatorYToLat(this.centerY) - mercLatPreserve
    const pl = poleLimit(this.projType)
    this.centerLatDeg = Math.max(-pl, Math.min(pl, latPreserve + delta))
  }

  /** Public sync hook for centerY writers outside the Camera class (the
   *  controller's pan fast-path / zoom-anchor block). Keeps the Mercator→lat
   *  formula in one place so callers don't re-inline mercatorYToLat. */
  syncCenterLat(): void {
    this._syncCenterLatFromMercator()
  }

  /** Mercator-metre bbox the centre must stay inside (mirrors CameraController's
   *  lon/lat `_maxBounds`), set by setMaxBounds so the gesture mutators honour
   *  bounds too — same shared-Camera propagation as minZoom. `null` = off.
   *  `northLat`/`southLat` carry the bbox's TRUE latitudes (degrees): the
   *  metre minY/maxY saturate at ±85.051129° (mercator.forward clamps), so the
   *  sphere family — whose centre legitimately reaches the pole — clamps
   *  centerLatDeg against these instead of the saturated metre Y. */
  private _maxBoundsMerc: { minX: number; maxX: number; minY: number; maxY: number; northLat: number; southLat: number } | null = null
  setMaxBoundsMerc(b: { minX: number; maxX: number; minY: number; maxY: number; northLat: number; southLat: number } | null): void {
    this._maxBoundsMerc = b
  }

  /** Clamp centre into `_maxBoundsMerc` (no-op when null). Called at each gesture
   *  mutator exit AFTER the world-wrap/pole clamp so bounds win. */
  private clampCenterToBounds(): void {
    const b = this._maxBoundsMerc
    if (!b) return
    this.centerX = Math.max(b.minX, Math.min(b.maxX, this.centerX))
    this.centerY = Math.max(b.minY, Math.min(b.maxY, this.centerY))
    // Sphere family (globe / ortho / azimuthal / stereo): centerLatDeg is the
    // pole-reaching authority. Clamping it from the SATURATED metre centerY
    // (via _syncCenterLatFromMercator) would pin it at ±85.05 and undo the
    // reach-the-pole behaviour (roadmap S12) whenever maxBounds' north/south
    // exceeds the Mercator limit. Clamp centerLatDeg against the bbox's TRUE
    // latitudes instead; centerY stays Mercator-bounded for the 2D/tile readers.
    if (representsCenterAs(this.projType) === 'lat-deg') {
      this.centerLatDeg = Math.max(b.southLat, Math.min(b.northLat, this.centerLatDeg))
      return
    }
    // Cylindrical family: the Mercator-metre clamp is correct — sync
    // centerLatDeg from the bounded centerY exactly as before (byte-identical).
    this._syncCenterLatFromMercator()
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
  private _cacheCap = NaN
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
  /** Build a `CameraView` snapshot of the scalar inputs the pure matrix
   *  builders read. Reads the accessor-gated `pitch` ONCE (so `pitchLocked`
   *  is honoured exactly as the inline reads did) and stamps the class FOV. */
  private _view(): CameraView {
    return {
      centerX: this.centerX,
      centerY: this.centerY,
      centerLatDeg: this.centerLatDeg,
      zoom: this.zoom,
      bearing: this.bearing,
      pitch: this.pitch,
      fovDeg: Camera.FOV,
      globeOrtho: this.globeOrtho,
      azimuthalProjType: this.azimuthalProjType,
    }
  }

  private _buildRTCMatrix(canvasWidth: number, canvasHeight: number, dpr: number = 1, viewHeightCap: number = WORLD_MERC): number {
    if (
      canvasWidth === this._cacheW &&
      canvasHeight === this._cacheH &&
      dpr === this._cacheDpr &&
      this.centerX === this._cacheCx &&
      this.centerY === this._cacheCy &&
      this.zoom === this._cacheZoom &&
      this.bearing === this._cacheBearing &&
      this.pitch === this._cachePitch &&
      viewHeightCap === this._cacheCap
    ) {
      return this._cacheFar
    }
    // Pure matrix algebra lives in view-matrix.ts (buildRTCMatrix). It writes
    // the MVP into the preallocated `rtcMatrix` buffer and returns far; the
    // cache shadow + invalidation below stay on the camera. The bearing-sign /
    // altitude-cap / near-far rationale is documented at the builder.
    const { far } = buildRTCMatrix(this._view(), canvasWidth, canvasHeight, dpr, viewHeightCap, this.rtcMatrix)
    this._cacheW = canvasWidth
    this._cacheH = canvasHeight
    this._cacheDpr = dpr
    this._cacheCx = this.centerX
    this._cacheCy = this.centerY
    this._cacheZoom = this.zoom
    this._cacheBearing = this.bearing
    this._cachePitch = this.pitch
    this._cacheCap = viewHeightCap
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
  private _globeFrame(canvasWidth: number, canvasHeight: number, dpr: number): { matrix: Float32Array; far: number; eye: ECEF } {
    // Pure builder (view-matrix.ts → buildGlobeFrame) derives lon from the
    // Mercator centerX, reads the maintained true centre latitude, delegates to
    // buildGlobeMatrix, and writes the RTC matrix into the preallocated
    // `_globeMatrix` buffer. `eye` is the orbit camera position in ABSOLUTE
    // sphere-ECEF metres (surfaced for the label back-face/horizon cull).
    const { far, eye } = buildGlobeFrame(this._view(), canvasWidth, canvasHeight, dpr, this._globeMatrix)
    return { matrix: this._globeMatrix, far, eye }
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
   *  (`WORLD_MERC = 2π × A`). Building on the WGS84 ellipsoid would introduce a
   *  0.67 % north-axis compression that breaks the ECEF-MVP↔legacy-Mercator
   *  convergence (`polygon-ecef-mvp-latitude-parity`, AC2c.1.5) at every
   *  non-equatorial latitude — verified: switching this to the ellipsoid blows
   *  19/24 cells past the 1.5 px gate. The vertex/camera frame "mismatch" the
   *  #189 guard pins is by design: the tiler's ellipsoid vertices stay within
   *  ≤1.5 px of this sphere anchor over an RTC tile extent, while keeping the
   *  Mercator pixel-parity (AC1) the sphere basis guarantees. See
   *  `lonLatToECEFSphere` for the full rationale. */
  getECEFCenter(): ECEF {
    // Derive lon from the Mercator centerX, but use the maintained true centre
    // latitude (centerLatDeg) instead of inverting the Mercator-bounded centerY.
    // For |lat|<=85.05 this is byte-identical to mercatorToECEFSphere(centerX,
    // centerY) (mercatorToECEFSphere(mx,my) === lonLatToECEFSphere(mx/A·RAD2DEG,
    // mercatorYToLat(my))); past 85.05 on the sphere it places the ECEF anchor
    // at the true pole-ward latitude so the globe orbit can reach the pole.
    return ecefCenterOf(this)
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
    // Derive the camera lon/lat from the canonical Mercator-metre anchor via
    // the shared CPU primitives (`EARTH_R`, the true centre latitude) so the
    // radius stays byte-identical to the rest of the projection module. Pure
    // body lives in view-matrix.ts (ecefToENUOf).
    return ecefToENUOf(this)
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
    // Build with the SAME per-projType view-height cap the render path uses
    // (getViewForProjection → getFrameView → flatViewHeightCapM, camera.ts:716),
    // mirroring this method's own `altitude` field below (:448). Without the cap
    // the matrix defaulted to WORLD_MERC while the GPU used flatViewHeightCapM
    // (2·EARTH_R for projType 3) → the snapshot reported a matrix for a DIFFERENT
    // camera than it rendered (internally inconsistent vs its cap-correct altitude).
    const far = this._buildRTCMatrix(canvasWidth, canvasHeight, dpr, flatViewHeightCapM(this.projType, WORLD_MERC))
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
    // Mirror the per-projType cap in `_buildRTCMatrix` so this debug
    // snapshot reports the altitude the production matrix actually uses
    // (WORLD_MERC for the cylindrical family; 2·EARTH_R for ortho — post-fix
    // for project_mercator_z0_pitch_render_2026_05_20 + the z0 disc cap).
    const rawViewHeightMeters = (canvasHeight / dpr) * metersPerPixel
    const viewHeightMeters = Math.min(rawViewHeightMeters, flatViewHeightCapM(this.projType, WORLD_MERC))
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
   *  camera overwrites this buffer.
   *
   *  ───────────────────────────────────────────────────────────────────
   *  Dual-API rationale (post Phase 2 PR 2d.5 ECEF migration):
   *
   *  3D / globe renderers (and Phase-1 non-Mercator projTypes) call
   *  `getECEFFrameView()` — `u.mvp` is the ECEF-MVP for those. The flat
   *  display path REVIVES this Mercator-DSFUN `getFrameView` as the flat
   *  2D-plane MVP: `getViewForProjection(projType=0)` returns it so a flat
   *  Mercator map projects onto a plane instead of a sphere (the PR #191
   *  'frame split = by-design' conclusion was wrong and is reverted). It
   *  also still anchors two parity-test surfaces:
   *
   *    1. **Parity test infrastructure** — `camera-ecef-mvp.test.ts` and
   *       `polygon-ecef-mvp-latitude-parity.test.ts` snapshot the legacy
   *       Mercator matrix here and assert ECEF parity at equator + grid
   *       coverage. Deleting this method would lose the verification
   *       anchor that proves ECEF math is equivalent to the production-
   *       proven Mercator-DSFUN path at the latitudes where they agree.
   *    2. **Camera coverage tests** — `camera.test.ts` +
   *       `camera-coverage.test.ts` use `getFrameView` to assert finite
   *       far + logDepthFc over the full (projType × pitch × bearing ×
   *       zoom) grid. Coverage of the legacy build path stays meaningful
   *       as long as anyone might regress to Mercator-RTC math.
   *
   *  Production callers go through `getViewForProjection`, which routes
   *  flat Mercator here and 3D / globe to `getECEFFrameView()`. */
  getFrameView(canvasWidth: number, canvasHeight: number, dpr: number = 1, viewHeightCap: number = WORLD_MERC): {
    matrix: Float32Array
    far: number
    logDepthFc: number
  } {
    if (this.globeMode) {
      const g = this._globeFrame(canvasWidth, canvasHeight, dpr)
      return { matrix: g.matrix, far: g.far, logDepthFc: computeLogDepthFc(g.far) }
    }
    const far = this._buildRTCMatrix(canvasWidth, canvasHeight, dpr, viewHeightCap)
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
    // Absolute sphere-ECEF camera position. Present ONLY on the globe-mode
    // (orbit) path — consumed by the label horizon cull. The non-globe ENU
    // ECEF branch below has no explicit eye vector (camera is the ENU origin),
    // so it stays undefined there.
    eye?: ECEF
  } {
    if (this.globeMode) {
      const g = this._globeFrame(canvasWidth, canvasHeight, dpr)
      return { matrix: g.matrix, far: g.far, logDepthFc: computeLogDepthFc(g.far), eye: g.eye }
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

    // Pure matrix algebra lives in view-matrix.ts (buildECEFFrameView): true-
    // ENU-metre altitude with the cos(lat) correction, near/far via the legacy
    // formula, and the P × T × Rx × Rz × Renu chain — written into the
    // preallocated `rtcMatrixECEF` buffer. The cos(lat) rationale + cap policy
    // are documented at the builder. The separate ECEF cache shadow stays here.
    const m = this.rtcMatrixECEF
    const { far } = buildECEFFrameView(this._view(), canvasWidth, canvasHeight, dpr, m)

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

  /** Display-projection view selector (flat 2D plane vs 3D globe over ECEF
   *  data). ECEF is the DATA coordinate system, but the DISPLAY projection
   *  is a SEPARATE concern: a flat 2D map (Mercator/…) projects the curved
   *  ECEF surface onto a plane; the globe shows it as a 3D sphere.
   *
   *  - Flat projections (projType 0-6, untilted): the flat 2D Mercator-metre
   *    MVP (`getFrameView` → `_buildRTCMatrix`, no camera-centre translate).
   *    The vertex shader feeds camera-relative 2D-plane metres — Mercator via
   *    `project(abs) − cam`, the other flat forms via `project_geom(abs,
   *    refLon) − project(camLon, camLat)` — so the curved ECEF data is
   *    flattened per vertex. This REVERSES the PR #191 'frame split', which
   *    was wrong as an end state for flat projections.
   *  - 3D (globe 7 / tilted azimuthal → globeMode): the ECEF MVP
   *    (`getECEFFrameView`).
   *
   *  Mirrors the render-loop flat/3D decision (render-loop.ts:141-155):
   *  tilted azimuthal promotes to projType 7 + sets globeMode. `projType`
   *  is passed explicitly so the renderer matrix ↔ shader VS branch stay in
   *  lockstep — the shader takes the flat branch exactly when
   *  `proj_params.x < 6.5` (projType 0-6), so the selector gates identically.
   *
   *  CRITICAL: returns a reference to a preallocated buffer (`rtcMatrix` for
   *  flat, `rtcMatrixECEF` / globe for 3D) — copy contents into your own
   *  uniform immediately; a subsequent call from the same camera overwrites
   *  it. */
  getViewForProjection(projType: number, canvasWidth: number, canvasHeight: number, dpr: number = 1): {
    matrix: Float32Array
    far: number
    logDepthFc: number
    // Absolute sphere-ECEF camera position — forwarded from the globe/ECEF
    // branch (undefined on the flat 2D branch). Lets the label projector apply
    // the same horizon cull the globe tile selector uses.
    eye?: ECEF
  } {
    if (!this.globeMode && !isGlobeProj(projType)) {
      return this.getFrameView(canvasWidth, canvasHeight, dpr, flatViewHeightCapM(projType, WORLD_MERC))
    }
    return this.getECEFFrameView(canvasWidth, canvasHeight, dpr)
  }

  // Mercator Y limit: ±85.051129° → ±20037508.34m
  private static readonly MAX_Y = 20037508.34

  // ── MVP Inverse (for screen → world unprojection) ──
  private rtcMatrixInv = new Float32Array(16)

  /** Get the inverse of the RTC matrix (cached per frame). The MVP cache
   *  in `_buildRTCMatrix` flips `_invDirty` only when the matrix actually
   *  changes; while the matrix is stable (e.g. across the 49 tile-selector
   *  unproject calls of a single frame) we skip the invert4x4 entirely. */
  getRTCMatrixInverse(canvasWidth: number, canvasHeight: number, dpr: number = 1): Float32Array {
    // Use the SAME per-projType cap the render path uses (getViewForProjection
    // → getFrameView) so screen→world unprojection describes the same camera as
    // the render. Without this, ortho's unproject would use the WORLD_MERC
    // default while its render uses the 2·EARTH_R cap — a ~π mismatch in
    // zoomAt/drag (this.projType is set every frame by the render loop).
    this._buildRTCMatrix(canvasWidth, canvasHeight, dpr, flatViewHeightCapM(this.projType, WORLD_MERC))
    if (this._invDirty) {
      invert4x4(this.rtcMatrix, this.rtcMatrixInv)
      this._invDirty = false
    }
    return this.rtcMatrixInv
  }

  /** Unproject screen pixel to z=0 world plane (RTC-relative).
   *  Returns [x, y] in projection meters relative to camera center, or null if behind horizon. */
  unprojectToZ0(screenX: number, screenY: number, canvasWidth: number, canvasHeight: number, dpr: number = 1): [number, number] | null {
    // Fetch the cached inverse (this method owns getRTCMatrixInverse + the
    // rtcMatrixInv buffer + _invDirty), then defer the pure inverse math to
    // unproject.ts.
    const inv = this.getRTCMatrixInverse(canvasWidth, canvasHeight, dpr)
    return unprojectToZ0Pure(inv, screenX, screenY, canvasWidth, canvasHeight)
  }

  /** Projection-unification step #8 — shared screen→geographic inverse
   *  composer (PR-D D1). Unprojects a screen pixel to TRUE lon/lat for the
   *  FLAT projType set, fixing the defect where every projType was inverted
   *  through a flat Mercator z=0 plane.
   *
   *  `unprojectToZ0` returns the projType's OWN projected-plane metres,
   *  camera-relative (== the shader `flat_rel`, because the flat MVP has no
   *  camera-centre translate). For mercator that plane IS the Mercator plane,
   *  so the legacy `rel + centre → mercator.inverse` is exact. For the
   *  cylindrical/pseudocylindrical/oblique non-merc set (projType 1/2/6) it
   *  is NOT Mercator metres — applying `mercator.inverse` recovers the wrong
   *  place on Earth (equirect ~6.4°, NE ~10.6°, oblique ~12.8° error). This
   *  composer instead re-adds `proj.forward(camLon,camLat)` (the projType's
   *  own-plane centre offset the shader subtracted) and applies the
   *  per-projType `getProjection(name).inverse` to recover geographic truth.
   *
   *  The camera centre (clon/clat) MUST match the GPU `proj_params.y/z`
   *  written in render-loop (centerX/Y → lon/lat with the ±85.051129° clamp)
   *  or the CPU inverse centre diverges from the rendered frame.
   *
   *  Returns null for projType 3/4/5 (azimuthal discs — limb singularity,
   *  deferred) and globe (7) so callers keep their existing behaviour for
   *  those; returns null when the ray misses the ground plane. */
  unprojectToLonLat(screenX: number, screenY: number, canvasWidth: number, canvasHeight: number, dpr: number = 1): [number, number] | null {
    // Wrapper: fetch the cached inverse (keeps getRTCMatrixInverse plumbing on
    // the camera), then run the pure compose. Equivalent to
    // unprojectToZ0 → _relToLonLat but threads the same inverse once.
    const inv = this.getRTCMatrixInverse(canvasWidth, canvasHeight, dpr)
    return unprojectToLonLatPure(this, inv, screenX, screenY, canvasWidth, canvasHeight)
  }

  /** Unproject a screen pixel to an ABSOLUTE Mercator-metre anchor — the
   *  drag-anchor space `panToScreenAnchor` consumes (centerX/Y are Mercator).
   *  For mercator (0) this is the legacy `rel + centre`; for the flat non-merc
   *  set (1/2/6) it composes through the projType inverse → lon/lat → Mercator
   *  so the anchor is the TRUE geographic point's Mercator metres (NOT the
   *  wrong `mercCentre + nonMercRel`). Returns null when the ray misses the
   *  ground or the projType is out of the flat-merc-composer scope (3/4/5/7),
   *  letting callers keep their existing behaviour there. */
  unprojectToMercatorAnchor(screenX: number, screenY: number, canvasWidth: number, canvasHeight: number, dpr: number = 1): [number, number] | null {
    // Wrapper: fetch the cached inverse, defer the pure anchor compose.
    const inv = this.getRTCMatrixInverse(canvasWidth, canvasHeight, dpr)
    return unprojectToMercatorAnchorPure(this, inv, screenX, screenY, canvasWidth, canvasHeight)
  }

  /** Compose an already-unprojected z=0-plane rel coordinate (the projType's
   *  own-plane metres returned by `unprojectToZ0`) into geographic lon/lat.
   *  Split from `unprojectToLonLat` so a caller holding a rel captured against
   *  a now-stale MVP (zoomAt's pre-zoom `before`) can recover its lon/lat
   *  without re-unprojecting against the live (post-zoom) matrix. See
   *  `unprojectToLonLat` for the per-projType math + scope. */
  private _relToLonLat(rel: [number, number]): [number, number] | null {
    // Wrapper: the per-projType inverse compose lives in unproject.ts; `this`
    // satisfies the UnprojectView snapshot (centerX/centerY/projType/globeMode).
    return relToLonLatPure(this, rel)
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
   *  Globe + the azimuthal discs (3/4/5) collapse to `[0]` — there is no
   *  cylindrical world wrap to enumerate. The x-periodic flat non-Mercator
   *  set (equirect 1 / natural_earth 2 / oblique_mercator 6) DOES wrap:
   *  return the SAME zoom-gated periodic copy set the tile selector emits
   *  (worldCopiesFor, gated by enumerateWorldCopies) so the CPU label
   *  projector fans out anchors over the same copies the GPU fills draw.
   *  Above WORLD_COPY_MAX_ZOOM (or globe) it collapses to `[0]`. */
  private _vwcMatrixId = -1
  private _vwcCached: readonly number[] = [0]
  getVisibleWorldCopies(canvasWidth: number, canvasHeight: number, dpr: number = 1): readonly number[] {
    if (this.globeMode) return [0]
    // x-periodic flat non-Mercator (1/2/6): mirror the tile-enumeration gate
    // exactly — worldCopiesFor() at zoom ≤ WORLD_COPY_MAX_ZOOM, else [0]. The
    // off-screen copies are NDC-culled downstream by the label projector, so
    // returning the full ±2 set (not a corner-derived range) keeps label
    // copies byte-identical to the tile/fill copies. Mercator (0) keeps the
    // corner-unprojection path below; azimuthal/globe (3/4/5/7) return [0] via
    // enumerateWorldCopies(periodic=false).
    if (this.projType !== 0) {
      return enumerateWorldCopies(this.projType, this.zoom)
        ? worldCopiesFor(this.projType)
        : [0]
    }
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
    const R = EARTH_R
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
      const R = EARTH_R
      const mpp = (WORLD_MERC / TILE_PX) / Math.pow(2, this.zoom)
      const rb = this.bearing * Math.PI / 180
      const cb = Math.cos(rb), sb = Math.sin(rb)
      const gdx = dx * cb + dy * sb
      const gdy = -dx * sb + dy * cb
      const degPerPx = (mpp / R) * (180 / Math.PI)
      let lon = this.centerX / R * (180 / Math.PI) - gdx * degPerPx
      // Read the TRUE centre latitude (centerLatDeg), NOT mercatorYToLat(centerY)
      // which saturates at ±85.051129 — otherwise a drag that started past the
      // Mercator limit (a pole-ward centre placed by setCenter / a prior drag)
      // would snap back to 85.05 every step. Nudge it and clamp to the
      // projection's pole limit (poleLimit=90 for the sphere family) so the
      // drag rolls the globe all the way to the pole (roadmap S12).
      const pl = poleLimit(this.projType)
      const lat = Math.max(-pl, Math.min(pl, this.centerLatDeg + gdy * degPerPx))
      lon = ((lon + 180) % 360 + 360) % 360 - 180
      this.centerX = lon * (Math.PI / 180) * R
      // centerLatDeg is authoritative for the sphere; centerY keeps the
      // Mercator-representable mirror (clamped ±85.05) for the 2D / tile-pyramid
      // readers. Write centerLatDeg DIRECTLY (no _syncCenterLatFromMercator,
      // which would reset it back to ≤85.05 and undo the pole reach).
      this.centerLatDeg = lat
      const mercLat = Math.max(-85.051129, Math.min(85.051129, lat))
      this.centerY = Math.log(Math.tan(Math.PI / 4 + mercLat * (Math.PI / 180) / 2)) * R
      this.clampCenterToBounds()
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

    // Rotate the screen delta by +bearing to get the map-space delta. This
    // MUST match the drag-anchor path (panToScreenAnchor, which inverts the
    // live MVP): a screen drag at bearing θ moves the world by Rot(+θ)·delta.
    // The prior Rot(−θ) form was off by 2θ — coincidentally correct only at
    // θ=0/180, so inertia flung the wrong way on a rotated map (drag was fine
    // because it uses panToScreenAnchor; inertia + the above-horizon fallback
    // use this path).
    const rad = this.bearing * Math.PI / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const mapDx = dx * cos - dy * sin
    const mapDy = dx * sin + dy * cos

    this.centerX -= mapDx * metersPerInputPixel
    // Wrap X to stay within one world width (prevents infinite drift)
    const halfWorld = WORLD_MERC / 2
    if (this.centerX > halfWorld) this.centerX -= WORLD_MERC
    else if (this.centerX < -halfWorld) this.centerX += WORLD_MERC
    const maxY = this.maxCameraY(canvasHeight)
    const newY = this.centerY + mapDy * metersPerInputPixel
    this.centerY = Math.max(-maxY, Math.min(maxY, newY))
    this._syncCenterLatFromMercator()
    this.clampCenterToBounds()
  }

  /** Rotate by delta degrees */
  rotate(deltaDeg: number): void {
    this.bearing = ((this.bearing + deltaDeg) % 360 + 360) % 360
  }

  /** Reset bearing to north-up */
  resetBearing(): void {
    this.bearing = 0
  }

  /** Zoom by delta at CSS screen position (clientX/clientY). Anchors the
   *  world point under the cursor: unproject via the BEFORE-zoom MVP, apply
   *  the delta, re-unproject, shift centerX/Y by the difference. Any
   *  pitch/bearing (unprojectToZ0 walks the full MVP). */
  zoomAt(delta: number, screenX: number, screenY: number, canvasWidth: number, canvasHeight: number): void {
    // A pure zoom must NOT move the centre latitude. Capture the TRUE centre
    // latitude and the Mercator-derived latitude BEFORE any centerY mutation,
    // so the trailing sync can carry centerLatDeg by the same delta centerY
    // moves (preserving a pole-ward sphere centre past 85.05). See
    // _carryCenterLatThroughZoom.
    const _latPreserve = this.centerLatDeg
    const _mercLatPreserve = mercatorYToLat(this.centerY)
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
    // unprojectToZ0 takes DEVICE-pixel screen coords (it scales by
    // canvasWidth which is device-px). Convert CSS clientX/Y → device.
    const sxDev = screenX * dpr
    const syDev = screenY * dpr

    if (this.globeMode) {
      // #11: anchor on the rendered sphere — unprojectToZ0 below is a
      // phantom flat plane in globe mode (16-20 px G5c drift).
      zoomAtGlobeAnchored(this, delta, sxDev, syDev, canvasWidth, canvasHeight, dpr)
      this.clampCenterToBounds()
      return
    }

    // World point under cursor BEFORE zoom — relative to current
    // camera (rel coords). For the untilted azimuthal discs (ortho 3 /
    // azimuthal-eq 4 / stereo 5) these are points on the DISC plane
    // (RTC, projection-centre-relative), NOT the Mercator plane, so the
    // Mercator-metre centre shift below would be wrong-scale and fling
    // the disc off-screen on every pinch step (G3a/G3b). The disc
    // branch instead pins the GEOGRAPHIC point under the fingers
    // (Cesium-style) by inverse-projecting it through the disc.
    const before = this.unprojectToZ0(sxDev, syDev, canvasWidth, canvasHeight, dpr)

    if (!this.globeMode && promotesToGlobeWhenTilted(this.projType)) {
      const R = EARTH_R
      // Only geo-anchor while the fingers are solidly inside the disc
      // inverse's well-conditioned region — each inverse turns singular
      // at its own radius (ortho: limb ρ→R; azimuthal-eq: antipode
      // ρ→πR; stereo: antipode pushed to ρ→∞): a sub-pixel screen move
      // there maps to a huge lon/lat swing that flings the disc ~tens
      // of degrees per step (a pinch midpoint is rarely dead-centre).
      // Past safeRho (camera-helpers.ts) we fall back to a plain centre-
      // anchored scale — Cesium's behaviour for a pinch beside the globe.
      const disc = discAnchorFor(this.projType)
      const onDisc = (p: [number, number] | null): boolean =>
        !!p && Math.hypot(p[0], p[1]) < disc.safeRho

      const lon0 = this.centerX / R
      const lat0 = mercatorYToLatRad(this.centerY)
      const anchor = onDisc(before) ? disc.inv(before![0], before![1], lon0, lat0) : null

      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + delta))

      if (anchor) {
        // Same screen point, new zoom, UNCHANGED centre → a different geo
        // point sits under the fingers; rotate the disc so the touched one
        // returns. One rotation is only locally linear (the disc frame RIDES
        // the centre); the residual compounds at low zoom (G3b z4: ~3.4 px
        // single-pass) — iterate like the flat non-merc arm below. STEP_LIM
        // clamps the TOTAL per-call rotation; LAT_LIM = Map's centerLat clamp.
        const STEP_LIM = 0.12 // rad ≈ 6.9° — invisibly large for real pinch
        const LAT_LIM = 85.051129 * Math.PI / 180
        const lim = (v: number) => Math.max(-STEP_LIM, Math.min(STEP_LIM, v))
        for (let iter = 0; iter < 6; iter++) {
          const q = this.unprojectToZ0(sxDev, syDev, canvasWidth, canvasHeight, dpr)
          const lonC = this.centerX / R, latC = mercatorYToLatRad(this.centerY)
          const cur = onDisc(q) ? disc.inv(q![0], q![1], lonC, latC) : null
          if (!cur) break
          const dLon = anchor[0] - cur[0], dLat = anchor[1] - cur[1]
          // Wrap the total before clamping — centerX may X-wrap mid-loop.
          const tot = ((lonC + dLon - lon0 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
          let newLon = lon0 + lim(tot)
          const newLat = Math.max(-LAT_LIM, Math.min(LAT_LIM, lat0 + lim(latC + dLat - lat0)))
          // Wrap longitude to (-π, π].
          newLon = ((newLon + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
          this.centerX = newLon * R
          this.centerY = R * Math.log(Math.tan(Math.PI / 4 + newLat / 2))
          if (Math.abs(dLon) < 1e-9 && Math.abs(dLat) < 1e-9) break // ≈6 mm ground: converged
        }
      }
      const maxYO = this.maxCameraY(canvasHeight)
      this.centerY = Math.max(-maxYO, Math.min(maxYO, this.centerY))
      this._carryCenterLatThroughZoom(_latPreserve, _mercLatPreserve)
      this.clampCenterToBounds()
      return
    }

    // Apply zoom; this also invalidates the MVP cache so the next
    // unproject below rebuilds against the new MPP.
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + delta))

    // World point under cursor AFTER zoom (camera not yet shifted).
    const after = this.unprojectToZ0(sxDev, syDev, canvasWidth, canvasHeight, dpr)

    // Shift centre so the BEFORE world point is under the cursor again.
    // before & after may be null if the cursor ray missed the ground
    // plane (high pitch, cursor above horizon) — then leave centre as
    // is, the zoom still applied around (0,0)-relative.
    if (before && after) {
      if (this.projType === 1 || this.projType === 2 || this.projType === 6) {
        // Flat non-merc (#8): `before` is the projType's OWN-plane rel metres
        // (NOT Mercator), so the raw `before−after` Mercator-metre delta is
        // wrong-scale. Anchor the GEOGRAPHIC point instead: recover the lon/lat
        // under the cursor BEFORE the zoom (from the pre-zoom `before` rel, via
        // _relToLonLat which reuses that rel rather than re-unprojecting), then
        // move the camera so that same geographic point sits under the cursor
        // again at the new zoom.
        //
        // FIXED POINT: the projType's central meridian RIDES the camera centre
        // (proj_params.y/z = camera lon/lat), so shifting the Mercator centre
        // re-centres the whole flat frame — a single Mercator-metre shift
        // leaves a residual that compounds across a streamed pinch (measured
        // ~33-37 px slide). convergeFlatAnchor (camera-helpers.ts — the loop's
        // verbatim extraction, shared with panToScreenAnchor's drag anchor)
        // iterates ≤6 passes to a 0.1 m threshold.
        const beforeGeo = this._relToLonLat(before)
        if (beforeGeo) {
          const targetM = mercator.forward(beforeGeo[0], beforeGeo[1])
          convergeFlatAnchor(this, targetM[0], targetM[1], sxDev, syDev, canvasWidth, canvasHeight, dpr)
        }
      } else {
        // Mercator (0) + globe (7): raw Mercator-metre delta (exact for
        // 0; globe still anchors the phantom flat plane — G5c, deferred).
        this.centerX += before[0] - after[0]
        this.centerY += before[1] - after[1]
        // Wrap X to stay within one world width (mirrors pan()).
        const halfWorld = WORLD_MERC / 2
        if (this.centerX > halfWorld) this.centerX -= WORLD_MERC
        else if (this.centerX < -halfWorld) this.centerX += WORLD_MERC
      }
    }

    // Clamp after zoom: visible area changes with zoom level.
    const maxY = this.maxCameraY(canvasHeight)
    this.centerY = Math.max(-maxY, Math.min(maxY, this.centerY))
    this._carryCenterLatThroughZoom(_latPreserve, _mercLatPreserve)
    this.clampCenterToBounds()
  }

  /** Pan so the world point captured at drag start stays under the cursor.
   *
   *  CRITICAL: `anchorWorldX/Y` is ABSOLUTE world (Mercator metres), stashed
   *  ONCE at drag start; each move assigns `centerX = anchor − cursor_rel`
   *  against the LIVE MVP. A camera-relative anchor goes stale each move →
   *  runaway accumulating drift; absolute + direct assignment is idempotent.
   *  Correct under any pitch/bearing (the unprojection walks the live MVP).
   *
   *  GLOBE MODE: `anchorWorldX/Y` are the anchored LON/LAT degrees instead
   *  (captured via the ray↔sphere inverse) — globe-anchor.ts. */
  panToScreenAnchor(
    anchorWorldX: number, anchorWorldY: number,
    cursorX: number, cursorY: number,
    canvasWidth: number, canvasHeight: number,
  ): void {
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
    if (this.globeMode) {
      // #11: ground-track the sphere via centerLatDeg (the Mercator path
      // below would clamp a pole-ward centre back to ±85.05).
      panGlobeToScreenAnchor(this, anchorWorldX, anchorWorldY, cursorX * dpr, cursorY * dpr, canvasWidth, canvasHeight, dpr)
      this.clampCenterToBounds()
      return
    }
    const cur = this.unprojectToZ0(cursorX * dpr, cursorY * dpr, canvasWidth, canvasHeight, dpr)
    if (!cur) return // ray missed ground (above horizon) — leave camera as-is
    if (this.projType === 1 || this.projType === 2 || this.projType === 6) {
      // Flat non-merc (#8): `cur` is the projType's OWN-plane rel metres, NOT
      // Mercator. `anchorWorldX/Y` is canonical Mercator metres (the geographic
      // anchor the controller forwarded through mercator), so the raw
      // Mercator-metre subtraction below would mix spaces. Run the SAME
      // fixed-point iteration as zoomAt's pinch anchor (B3 — the old
      // single-pass here both mixed absolute-vs-relative Mercator metres and
      // ignored that the central meridian rides the centre, sliding the
      // grabbed point hundreds of px over a 30-step drag; gate: interaction-
      // contract-gates G1c). Guarded so 0/3/4/5/7 keep the raw subtraction
      // byte-identical.
      convergeFlatAnchor(this, anchorWorldX, anchorWorldY, cursorX * dpr, cursorY * dpr, canvasWidth, canvasHeight, dpr)
    } else {
      this.centerX = anchorWorldX - cur[0]
      this.centerY = anchorWorldY - cur[1]
    }
    const halfWorld = WORLD_MERC / 2
    if (this.centerX > halfWorld) this.centerX -= WORLD_MERC
    else if (this.centerX < -halfWorld) this.centerX += WORLD_MERC
    const maxY = this.maxCameraY(canvasHeight)
    this.centerY = Math.max(-maxY, Math.min(maxY, this.centerY))
    this._syncCenterLatFromMercator()
    this.clampCenterToBounds()
  }
}
