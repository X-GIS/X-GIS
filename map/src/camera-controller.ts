// ═══ X-GIS CameraController — camera/viewport API cluster ═══
//
// First structural decomposition of XGISMap: the Mapbox-API-parity
// camera/viewport methods (setCenter / setZoom / jumpTo / fitBounds /
// panBy / getBounds / getCameraState / …) plus the two fields they own
// (`_maxBounds`, `_cameraExplicitlyPositioned`) live here. XGISMap keeps
// the shared `Camera` instance and delegates to a single CameraController
// constructed in its ctor.
//
// BEHAVIOR + PUBLIC API IDENTICAL — every method below is moved verbatim
// from map.ts; only the dependency wiring changed:
//   - `this.invalidate()`   → injected `invalidate` callback
//   - `this.getCanvas()`    → injected `getCanvas` accessor
//   - `this.ctx?.canvas`    → injected `getCtxCanvas` accessor
//   - `this._maxBounds` / `this._cameraExplicitlyPositioned` → owned here

import { Camera } from './camera'
import { MERCATOR_LAT_LIMIT, mercatorYToLat, mercatorYToLatRad, mercator } from '@xgis/geo'
import { poleLimit, representsCenterAs } from '@xgis/geo'
import { WORLD_MERC, TILE_PX } from '@xgis/geo'
import { canvasEffectiveDpr, effectiveDpr } from '@xgis/engine'
import { lonLatToMercator } from '@xgis/data'
import { xlog, activeBody } from '@xgis/shared'
import {
  CameraAnimator,
  defaultNow,
  defaultRaf,
  defaultCancelRaf,
  type EaseToOptions,
  type FlyToOptions,
} from './camera-animation'
import { prefersReducedMotion } from './map-accessibility'

/** Dependencies CameraController needs from the host XGISMap. */
export interface CameraControllerDeps {
  /** Mark a render as needed (XGISMap's `invalidate()`). */
  invalidate(): void
  /** The active canvas — `this.ctx?.canvas ?? this.canvas` on the host.
   *  Used by `getBounds` for the viewport span. */
  getCanvas(): HTMLCanvasElement
  /** The GPU-context canvas only (`this.ctx?.canvas`), or undefined when
   *  the WebGPU context hasn't initialized yet. Used by `fitBounds` for
   *  the padding-adjusted zoom fit — kept distinct from `getCanvas` so
   *  the pre-init fallback (→ 800) stays byte-identical. */
  getCtxCanvas(): HTMLCanvasElement | undefined
  // ── easeTo/flyTo animation clock (all optional; default to real browser
  //    infra). Injected so a stepped-clock unit test drives the transition to
  //    completion deterministically. ──
  /** Monotonic ms clock. Default performance.now. */
  now?(): number
  /** Schedule a frame; returns null when no frame source exists. Default rAF. */
  raf?(cb: (t: number) => void): number | null
  /** Cancel a scheduled frame. Default cancelAnimationFrame. */
  cancelRaf?(handle: number): void
  /** prefers-reduced-motion probe. Default reads matchMedia (map-accessibility). */
  prefersReducedMotion?(): boolean
}

export class CameraController {
  private readonly camera: Camera
  private readonly invalidate: () => void
  private readonly getCanvas: () => HTMLCanvasElement
  private readonly getCtxCanvas: () => HTMLCanvasElement | undefined
  /** easeTo/flyTo transition driver. Drives THIS controller's jumpTo each
   *  frame (single mutation authority) — see camera-animation.ts. */
  private readonly animator: CameraAnimator

  constructor(camera: Camera, deps: CameraControllerDeps) {
    this.camera = camera
    this.invalidate = deps.invalidate
    this.getCanvas = deps.getCanvas
    this.getCtxCanvas = deps.getCtxCanvas
    this.animator = new CameraAnimator({
      getPose: () => this.getCameraState(),
      // Single authority: every animation frame drives the SAME jumpTo the
      // gesture / programmatic paths use, so keep-warm + move/zoom lifecycle
      // events re-arm through the injected invalidate for free.
      applyCameraOpts: (o) => this.jumpTo(o),
      getViewport: () => this._viewportCss(),
      getProjType: () => this.camera.projType,
      prefersReducedMotion: deps.prefersReducedMotion ?? prefersReducedMotion,
      now: deps.now ?? defaultNow,
      raf: deps.raf ?? defaultRaf,
      cancelRaf: deps.cancelRaf ?? defaultCancelRaf,
    })
  }

  /** Viewport in CSS px for the van Wijk w0 span. Reads the active canvas
   *  defensively (the validation-test harness's getCanvas throws, and flyTo
   *  never reaches here for an invalid center); falls back to 800×600 (the same
   *  pre-init default fitBounds uses) when no canvas is available. */
  private _viewportCss(): { width: number; height: number } {
    let canvas: HTMLCanvasElement | undefined
    try {
      canvas = this.getCanvas()
    } catch {
      canvas = undefined
    }
    if (!canvas || !canvas.width) return { width: 800, height: 600 }
    const dpr = this._dpr(canvas)
    return { width: canvas.width / dpr, height: canvas.height / dpr }
  }

  /** Mapbox-API parity: programmatic camera control.
   *
   *  Each setter validates the input (Number.isFinite + spec range
   *  clamps) before assigning to the camera. Invalid input is dropped
   *  with a warn-once and the camera state is unchanged — mirrors the
   *  defensive resets at renderFrame top (iter 419) but catches the
   *  bad call upstream so the host sees the warning. */
  setCenter(lon: number, lat: number): void {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      xlog.warn(`[X-GIS] setCenter: non-finite (lon=${lon}, lat=${lat}); ignored.`)
      return
    }
    // Honor setMaxBounds: clamp the input lon/lat to the bbox before
    // projecting. Without this, jumpTo could escape the constraint.
    let cLon = lon,
      cLat = lat
    if (this._maxBounds) {
      cLon = Math.max(this._maxBounds.west, Math.min(this._maxBounds.east, cLon))
      cLat = Math.max(this._maxBounds.south, Math.min(this._maxBounds.north, cLat))
    }
    // Dual clamp: centerY must stay Mercator-representable (±85.051129) so the
    // 2D plane MVP / tile selection keep working, but the TRUE centre latitude
    // (centerLatDeg) may reach the projType's pole — for the sphere family
    // (globe/ortho/azi/stereo, poleLimit=90) this is how setCenter([0,89]) on
    // the globe orbits the camera to the pole instead of saturating at 85.05.
    // For cylindrical projections poleLimit=85.051129 ⇒ trueLat===mercLat ⇒
    // centerLatDeg===mercatorYToLat(centerY): byte-identical to the old clamp.
    const pl = poleLimit(this.camera.projType)
    const trueLat = Math.max(-pl, Math.min(pl, cLat))
    const mercLat = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, cLat))
    const [mx, my] = lonLatToMercator(cLon, mercLat)
    this.camera.centerX = mx
    this.camera.centerY = my
    this.camera.centerLatDeg = trueLat
    this.invalidate()
  }

  setZoom(zoom: number): void {
    if (!Number.isFinite(zoom)) {
      xlog.warn(`[X-GIS] setZoom: non-finite (${zoom}); ignored.`)
      return
    }
    this.camera.zoom = Math.max(this.camera.minZoom, Math.min(this.camera.maxZoom, zoom))
    this.invalidate()
  }

  /** Mapbox-API parity: set the lower / upper bound for camera.zoom.
   *  Subsequent setZoom / jumpTo / user pan-zoom gestures clamp to
   *  the active bounds. Default min=0 / max=22. */
  setMinZoom(z: number): void {
    if (!Number.isFinite(z)) {
      xlog.warn(`[X-GIS] setMinZoom: non-finite (${z}); ignored.`)
      return
    }
    // Reconcile against maxZoom: minZoom must never exceed maxZoom or the
    // shared zoom clamp Math.max(min, Math.min(max, z)) collapses to `min`,
    // pinning the camera ABOVE maxZoom and locking it. (MapLibre invariant
    // min<=max.)
    this.camera.minZoom = Math.min(Math.max(0, Math.min(22, z)), this.camera.maxZoom)
    if (this.camera.zoom < this.camera.minZoom) {
      this.camera.zoom = this.camera.minZoom
      this.invalidate()
    }
  }
  setMaxZoom(z: number): void {
    if (!Number.isFinite(z)) {
      xlog.warn(`[X-GIS] setMaxZoom: non-finite (${z}); ignored.`)
      return
    }
    // Reconcile against minZoom (see setMinZoom) so min<=max always holds.
    this.camera.maxZoom = Math.max(Math.max(0, Math.min(22, z)), this.camera.minZoom)
    if (this.camera.zoom > this.camera.maxZoom) {
      this.camera.zoom = this.camera.maxZoom
      this.invalidate()
    }
  }
  getMinZoom(): number {
    return this.camera.minZoom
  }
  getMaxZoom(): number {
    return this.camera.maxZoom
  }

  /** Mapbox-API parity: increment / decrement zoom by 1.
   *  Animation arg is accepted but ignored (no transition infra) —
   *  matches MapLibre signature so callers can port code unchanged.
   *  Result is clamped to [minZoom, maxZoom]. */
  zoomIn(): void {
    this.setZoom(this.camera.zoom + 1)
  }
  zoomOut(): void {
    this.setZoom(this.camera.zoom - 1)
  }

  /** Mapbox-API parity: constrain pan to a lon/lat bounding box.
   *  Subsequent setCenter / jumpTo / user pan gestures clamp the
   *  camera center inside the bbox so the view can't drift outside
   *  the deployment's intended area. Pass `null` to clear. */
  private _maxBounds: { west: number; south: number; east: number; north: number } | null = null
  setMaxBounds(bounds: [[number, number], [number, number]] | null): void {
    if (bounds === null) {
      this._maxBounds = null
      this.camera.setMaxBoundsMerc(null)
      return
    }
    const [[w, s], [e, n]] = bounds
    if (
      !Number.isFinite(w) ||
      !Number.isFinite(s) ||
      !Number.isFinite(e) ||
      !Number.isFinite(n) ||
      s > n ||
      s < -90 ||
      n > 90
    ) {
      xlog.warn(`[X-GIS] setMaxBounds: invalid bounds (${w},${s})-(${e},${n}); ignored.`)
      return
    }
    // Antimeridian-crossing bbox (west > east) is unsupported — the
    // clamp math expects a contiguous [west, east] range. Hosts that
    // need a Pacific-rim deployment can split the bbox in two halves
    // (the meridian-east arc + meridian-west arc) and pick whichever
    // the camera is currently inside, or pre-process the data to live
    // entirely in [-180, 180] without wrap. Reject loudly so callers
    // don't get a silently-incorrect clamp.
    if (w > e) {
      xlog.warn(
        `[X-GIS] setMaxBounds: antimeridian-crossing bbox (west=${w} > east=${e}) not supported; ignored.`,
      )
      return
    }
    this._maxBounds = { west: w, south: s, east: e, north: n }
    // Propagate to the shared Camera in Mercator metres so the INTERACTIVE
    // gesture mutators (camera.pan / panToScreenAnchor / zoomAt) honour the
    // bounds too — they drive the Camera directly and never see the lon/lat
    // clamp above. mercator.forward is the SAME forward the Camera uses to
    // derive centerX/centerY (it clamps lat to MERCATOR_LAT_LIMIT), so the
    // Mercator box matches the camera's coordinate space exactly. minY comes
    // from the SOUTH lat, maxY from the NORTH lat.
    const [minX, minY] = mercator.forward(w, s)
    const [maxX, maxY] = mercator.forward(e, n)
    // Carry the TRUE north/south latitudes alongside the (Mercator-saturated)
    // metre box: the sphere family clamps centerLatDeg against these so a
    // maxBounds past ±85.05 doesn't pin the globe centre below the pole.
    this.camera.setMaxBoundsMerc({ minX, maxX, minY, maxY, northLat: n, southLat: s })
    // Immediately clamp current center inside the new bounds.
    const state = this.getCameraState()
    const lon = state.center[0]
    const lat = state.center[1]
    const clampedLon = Math.max(w, Math.min(e, lon))
    const clampedLat = Math.max(s, Math.min(n, lat))
    if (clampedLon !== lon || clampedLat !== lat) {
      this.setCenter(clampedLon, clampedLat)
    }
  }
  getMaxBounds(): [[number, number], [number, number]] | null {
    if (!this._maxBounds) return null
    const b = this._maxBounds
    return [
      [b.west, b.south],
      [b.east, b.north],
    ]
  }

  /** Mapbox-API parity: return the visible map bbox in lon/lat.
   *  Approximation that ignores bearing + pitch — at non-zero pitch
   *  the actual visible polygon is trapezoid-shaped; this returns
   *  the axis-aligned bbox of the pitch=0 equivalent extent, which
   *  is a strict under-estimate for narrow views and over-estimate
   *  for wide tilted views. Matches MapLibre GL JS's shape for the
   *  return value (`getBounds()` returns LngLatBounds). */
  getBounds(): [[number, number], [number, number]] {
    const canvas = this.getCanvas()
    // canvas.width/height are DEVICE px (clientWidth*dpr, gpu.ts
    // resizeCanvas); degPerPx below is per-CSS-pixel, so strip the dpr to
    // get the CSS-px viewport span. Without this the bbox is dpr× too wide.
    const dpr = this._dpr(canvas)
    const cssW = (canvas?.width ?? 800) / dpr
    const cssH = (canvas?.height ?? 600) / dpr
    // degrees-per-pixel at current zoom (formula matches the inverse
    // of _fitZoomToLonSpan: zoom = log2(360 / (degPerPx * 256)) - 1
    // so degPerPx = 360 / (256 * 2^(zoom + 1))).
    const degPerPx = 360 / (256 * Math.pow(2, this.camera.zoom + 1))
    const halfLonSpan = (cssW * degPerPx) / 2
    // Latitude span uses the same degPerPx as a rough approximation;
    // proper Mercator inverse would scale with cos(centerLat) but the
    // bbox is over-estimated near the poles either way.
    const halfLatSpan = (cssH * degPerPx) / 2
    const state = this.getCameraState()
    const west = state.center[0] - halfLonSpan
    const east = state.center[0] + halfLonSpan
    const south = Math.max(-90, state.center[1] - halfLatSpan)
    const north = Math.min(90, state.center[1] + halfLatSpan)
    return [
      [west, south],
      [east, north],
    ]
  }

  /** Mapbox-API parity: fit the camera to a lon/lat bounding box.
   *  Picks zoom from the lon-span (matches the internal heuristic in
   *  _fitZoomToLonSpan), centers on the bbox midpoint, and applies
   *  bearing=0 / pitch=0 unless the caller overrides. Honors
   *  maxBounds (clamp post-fit) and the active zoom bounds. */
  fitBounds(
    bounds: [[number, number], [number, number]],
    opts: { padding?: number; bearing?: number; pitch?: number } = {},
  ): void {
    const [[w, s], [e, n]] = bounds
    if (
      !Number.isFinite(w) ||
      !Number.isFinite(s) ||
      !Number.isFinite(e) ||
      !Number.isFinite(n) ||
      s > n
    ) {
      xlog.warn(`[X-GIS] fitBounds: invalid bounds (${w},${s})-(${e},${n}); ignored.`)
      return
    }
    // Antimeridian-crossing bbox (west > east) is unsupported — same as
    // setMaxBounds. Without this guard lonSpan = Math.max(1e-9, e-w) collapses
    // to 1e-9 (e-w is negative), the fit silently falls back to zoom 4, and
    // centerLon = (w+e)/2 lands on the ANTIPODE of the intended centre. Reject
    // loudly so callers don't get a silently-wrong camera.
    if (w > e) {
      xlog.warn(
        `[X-GIS] fitBounds: antimeridian-crossing bbox (west=${w} > east=${e}) not supported; ignored.`,
      )
      return
    }
    const centerLon = (w + e) / 2
    const centerLat = (s + n) / 2
    const lonSpan = Math.max(1e-9, e - w)
    // canvas.width is DEVICE px (clientWidth*dpr, gpu.ts resizeCanvas) but
    // _fitZoomToLonSpan's degPerPx→zoom math expects CSS px, so strip the
    // dpr first (matches map.ts's canonical `this.canvas.width / dpr`). The
    // 800 fallback (no ctx yet) is already a CSS-notional default — leave
    // it un-divided. THEN subtract padding (CSS px per Mapbox) in CSS space.
    const ctxCanvas = this.getCtxCanvas()
    const dpr = this._dpr(ctxCanvas)
    const ctxW = ctxCanvas?.width
    const ctxH = ctxCanvas?.height
    const cssCanvasW = ctxW !== undefined ? ctxW / dpr : 800
    const cssCanvasH = ctxH !== undefined ? ctxH / dpr : 600
    const padding = opts.padding ?? 0
    const canvasW = cssCanvasW - padding * 2
    const canvasH = cssCanvasH - padding * 2
    const cssWidthPx = canvasW > 0 ? canvasW : 800
    const cssHeightPx = canvasH > 0 ? canvasH : 600
    const lonFitZoom = this._fitZoomToLonSpan(lonSpan, cssWidthPx)
    const latFitZoom = this._fitZoomToMercYSpan(s, n, cssHeightPx)
    const zoom = Math.min(lonFitZoom, latFitZoom)
    this.jumpTo({
      center: [centerLon, centerLat],
      zoom,
      bearing: opts.bearing ?? 0,
      pitch: opts.pitch ?? 0,
    })
  }

  /** Mapbox-API parity: `easeTo` / `flyTo` — the ANIMATED variants of jumpTo
   *  (#1256). Both drive this controller's jumpTo each frame (single mutation
   *  authority) via the shared CameraAnimator, cancel on any user gesture (the
   *  map wires the controller pointer/wheel handlers to `cancelAnimation`),
   *  supersede on a new call, and settle EXACTLY on the target (final frame
   *  byte-identical to jumpTo(target)). With prefers-reduced-motion set — or no
   *  frame source (SSR/node) — they collapse to an instant jumpTo(target).
   *
   *  easeTo: one eased interpolation of center/zoom/bearing/pitch (default cubic
   *  in-out; center great-circle on the globe, straight Mercator lerp on flat). */
  easeTo(opts: EaseToOptions): void {
    this.animator.easeTo(opts)
  }
  /** flyTo: the van Wijk & Nuij (2003) optimal zoom-out-in path (ρ default 1.42),
   *  duration derived from the path length unless overridden. A near-equal-center
   *  call degenerates to easeTo (no pan to arc). */
  flyTo(opts: FlyToOptions): void {
    this.animator.flyTo(opts)
  }

  /** Abort an in-flight easeTo/flyTo, leaving the camera where the transition
   *  had reached (NOT snapped to target). MapLibre semantics: the map calls this
   *  from the controller pointer/wheel/keyboard handlers so a user gesture takes
   *  over the camera. No-op when nothing is animating. */
  cancelAnimation(): void {
    this.animator.cancel()
  }

  /** Whether an easeTo/flyTo transition is currently in flight. */
  isAnimating(): boolean {
    return this.animator.isActive()
  }

  /** Mapbox-API parity: pan the map by an offset in CSS pixels.
   *  Positive dx moves the map LEFT (camera moves RIGHT in world);
   *  positive dy moves the map UP (camera moves DOWN). Honors the
   *  current bearing so a +dx with bearing=90 pans north, not east. */
  panBy(offset: [number, number]): void {
    if (!Number.isFinite(offset[0]) || !Number.isFinite(offset[1])) {
      xlog.warn(`[X-GIS] panBy: non-finite offset (${offset[0]}, ${offset[1]}); ignored.`)
      return
    }
    const mpp = WORLD_MERC / TILE_PX / Math.pow(2, this.camera.zoom)
    // CSS-px → Mercator meters at current zoom. The camera works in CSS
    // pixels (Camera.pan is DPR-invariant, commit ee1f394) and `mpp` uses
    // the same metres-per-CSS-pixel as view-matrix.ts, so NO dpr factor:
    // panBy([100,0]) must move the same world distance as a 100-CSS-pixel
    // drag regardless of devicePixelRatio.
    const dxMerc = offset[0] * mpp
    const dyMerc = offset[1] * mpp
    // Bearing rotation: screen-space +x is the map's east only when
    // bearing=0. Rotate the offset back into the map's reference frame.
    const bearingRad = (this.camera.bearing * Math.PI) / 180
    const cos = Math.cos(bearingRad),
      sin = Math.sin(bearingRad)
    const dxMap = dxMerc * cos - dyMerc * sin
    const dyMap = dxMerc * sin + dyMerc * cos
    // Route the result through setCenter so the maxBounds clamp
    // applies. Convert the new Mercator center back to lon/lat first
    // since setCenter expects lon/lat, then setCenter re-projects.
    if (this._maxBounds) {
      const EARTH = activeBody().sphereR,
        D2R = Math.PI / 180
      const newMercX = this.camera.centerX + dxMap
      const newMercY = this.camera.centerY - dyMap // screen-y inverted
      const newLon = newMercX / (D2R * EARTH)
      const newLatRad = mercatorYToLatRad(newMercY)
      const newLat = (newLatRad * 180) / Math.PI
      this.setCenter(newLon, newLat)
    } else {
      this.camera.centerX += dxMap
      // Wrap X to ±WORLD_MERC/2 — mirrors Camera.pan to prevent antimeridian drift.
      const halfWorld = WORLD_MERC / 2
      if (this.camera.centerX > halfWorld) this.camera.centerX -= WORLD_MERC
      else if (this.camera.centerX < -halfWorld) this.camera.centerX += WORLD_MERC
      this.camera.centerY -= dyMap
      // Clamp Y to ±MAX_Y (Mercator limit ≈ ±85.051129°) — mirrors Camera.pan.
      const MAX_Y = WORLD_MERC / 2 // 20037508.34m = mercator(±85.051129°)
      this.camera.centerY = Math.max(-MAX_Y, Math.min(MAX_Y, this.camera.centerY))
      // Keep centerLatDeg synced from the final Mercator centerY.
      this.camera.syncCenterLat()
      this.invalidate()
    }
  }

  setBearing(bearing: number): void {
    if (!Number.isFinite(bearing)) {
      xlog.warn(`[X-GIS] setBearing: non-finite (${bearing}); ignored.`)
      return
    }
    // Wrap to [0, 360). Negative bearings wrap to positive equivalent.
    this.camera.bearing = ((bearing % 360) + 360) % 360
    this.invalidate()
  }

  setPitch(pitch: number): void {
    if (!Number.isFinite(pitch)) {
      xlog.warn(`[X-GIS] setPitch: non-finite (${pitch}); ignored.`)
      return
    }
    this.camera.pitch = Math.max(0, Math.min(85, pitch))
    this.invalidate()
  }

  /** Mapbox-API parity: bulk camera update. Applies center, zoom,
   *  bearing, pitch in one call with a single invalidate() at the
   *  end — avoids the 4-invalidate cascade of calling each setter
   *  individually. Each field is optional and routes through the
   *  same validation as the per-axis setters; invalid fields warn
   *  and the rest of the call still applies.
   *
   *  Matches MapLibre GL JS `map.jumpTo({ center: [lon, lat], zoom, bearing, pitch })`. */
  jumpTo(opts: {
    center?: [number, number]
    zoom?: number
    bearing?: number
    pitch?: number
  }): void {
    if (opts.center) {
      // Guard the destructure: a non-array `center` (e.g. `{}` or a bare
      // object) is non-iterable and would throw a TypeError that propagates
      // through the easeTo/flyTo aliases. Every other validator here
      // warns-and-ignores, so match that contract.
      if (!Array.isArray(opts.center) || opts.center.length < 2) {
        xlog.warn(`[X-GIS] jumpTo: center must be [lon, lat]; skipped.`)
      } else {
        const [lon, lat] = opts.center
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
          xlog.warn(`[X-GIS] jumpTo: non-finite center (${lon}, ${lat}); skipped.`)
        } else {
          // Honor maxBounds clamp first.
          let cLon = lon,
            cLat = lat
          if (this._maxBounds) {
            cLon = Math.max(this._maxBounds.west, Math.min(this._maxBounds.east, cLon))
            cLat = Math.max(this._maxBounds.south, Math.min(this._maxBounds.north, cLat))
          }
          // Same dual clamp as setCenter: centerY stays Mercator-representable,
          // centerLatDeg carries the true (possibly pole-ward) centre latitude so
          // jumpTo({ center: [0, 89] }) on the globe reaches the pole. Byte-
          // identical for cylindrical projections (poleLimit=85.051129).
          const pl = poleLimit(this.camera.projType)
          const trueLat = Math.max(-pl, Math.min(pl, cLat))
          const mercLat = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, cLat))
          const [mx, my] = lonLatToMercator(cLon, mercLat)
          this.camera.centerX = mx
          this.camera.centerY = my
          this.camera.centerLatDeg = trueLat
        }
      }
    }
    if (opts.zoom !== undefined) {
      if (!Number.isFinite(opts.zoom)) {
        xlog.warn(`[X-GIS] jumpTo: non-finite zoom (${opts.zoom}); skipped.`)
      } else {
        this.camera.zoom = Math.max(this.camera.minZoom, Math.min(this.camera.maxZoom, opts.zoom))
      }
    }
    if (opts.bearing !== undefined) {
      if (!Number.isFinite(opts.bearing)) {
        xlog.warn(`[X-GIS] jumpTo: non-finite bearing (${opts.bearing}); skipped.`)
      } else {
        this.camera.bearing = ((opts.bearing % 360) + 360) % 360
      }
    }
    if (opts.pitch !== undefined) {
      if (!Number.isFinite(opts.pitch)) {
        xlog.warn(`[X-GIS] jumpTo: non-finite pitch (${opts.pitch}); skipped.`)
      } else {
        this.camera.pitch = Math.max(0, Math.min(85, opts.pitch))
      }
    }
    this.invalidate()
  }

  /** Mapbox-API parity: per-axis getters. Match MapLibre GL JS's
   *  `map.getCenter() / getZoom() / getBearing() / getPitch()`.
   *  `getCenter` returns lon/lat (NOT Mercator meters) so callers
   *  can round-trip back through setCenter / jumpTo. */
  getCenter(): [number, number] {
    return this.getCameraState().center
  }
  getZoom(): number {
    return this.camera.zoom
  }
  getBearing(): number {
    return this.camera.bearing
  }
  getPitch(): number {
    return this.camera.pitch
  }

  /** Mapbox-API parity: read the current camera state as a single
   *  object. Returns longitude/latitude (NOT Mercator meters) so
   *  callers can round-trip through jumpTo.
   *
   *  Named `getCameraState` to avoid clashing with the existing
   *  `getCamera(): Camera` which returns the internal Camera instance. */
  getCameraState(): { center: [number, number]; zoom: number; bearing: number; pitch: number } {
    // Inverse Mercator: x → lon, y → lat. EARTH_RADIUS / DEG2RAD
    // constants match the lonLatToMercator forward in geojson.ts.
    // Number.isFinite gate: if camera.centerX/Y got into NaN/Infinity
    // upstream (the renderFrame defensive reset doesn't fire until
    // the next frame), report 0/0 instead of NaN coords. Otherwise
    // getCameraState → jumpTo round-trip locks the camera into NaN.
    const EARTH_RADIUS = activeBody().sphereR
    const DEG2RAD = Math.PI / 180
    const cx = Number.isFinite(this.camera.centerX) ? this.camera.centerX : 0
    const cy = Number.isFinite(this.camera.centerY) ? this.camera.centerY : 0
    const lon = cx / (DEG2RAD * EARTH_RADIUS)
    // Sphere family (globe/ortho/azi/stereo) stores its TRUE centre latitude in
    // centerLatDeg, which can exceed the Mercator ±85.05 limit (reach-the-pole).
    // Report THAT so getCenter([0,89]) round-trips on the globe instead of
    // saturating at 85.05. Cylindrical projections keep the Mercator-Y inverse
    // (byte-identical: centerLatDeg===mercatorYToLat(centerY) there). Fall back
    // to the Mercator-derived value if centerLatDeg is somehow non-finite.
    let lat: number
    if (
      representsCenterAs(this.camera.projType) === 'lat-deg' &&
      Number.isFinite(this.camera.centerLatDeg)
    ) {
      lat = this.camera.centerLatDeg
    } else {
      lat = mercatorYToLat(cy)
    }
    return {
      center: [lon, lat],
      zoom: Number.isFinite(this.camera.zoom) ? this.camera.zoom : 0,
      bearing: Number.isFinite(this.camera.bearing) ? this.camera.bearing : 0,
      pitch: Number.isFinite(this.camera.pitch) ? this.camera.pitch : 0,
    }
  }

  /** Map a feature-bounds lon-span to the auto-fit camera zoom. Shared
   *  across the four bounds-fit sites (sync setRawParts, async GeoJSON
   *  compile lands, VirtualPMTiles attach). Pulled into one place
   *  because a degenerate `lonSpan === 0` (single-point or co-linear
   *  fixtures like fixture-point.geojson) made the inline
   *  `Math.log2(360 / (degPerPx * 256))` collapse to Infinity → camera.
   *  zoom = Infinity → broken projection matrix → blank canvas with a
   *  `#Infinity/0/0` badge. */
  _fitZoomToLonSpan(lonSpan: number, cssWidthPx: number): number {
    // Degenerate bounds → pin a country-level zoom. SDF point billboards
    // (size-40-class fixtures) read cleanly here, and the user can still
    // wheel-zoom out.
    if (!(lonSpan > 1e-9) || !(cssWidthPx > 0)) return 4
    const degPerPx = lonSpan / cssWidthPx
    return Math.max(0.5, Math.log2(360 / (degPerPx * 256)) - 1)
  }

  /** Map a latitude bbox [s, n] to the fit zoom for the Y axis.
   *  Projects s and n to Mercator-Y meters, takes the Y span, and
   *  inverts the mpp formula: mpp = WORLD_MERC/TILE_PX/2^z, so
   *  2^z = WORLD_MERC * cssHeightPx / (TILE_PX * ySpan).
   *  Used by fitBounds to pick the MORE CONSTRAINING axis (lon vs lat). */
  _fitZoomToMercYSpan(latS: number, latN: number, cssHeightPx: number): number {
    if (!(cssHeightPx > 0)) return 4
    const EARTH = activeBody().sphereR,
      D2R = Math.PI / 180,
      LAT_LIMIT = 85.051129
    const clampS = Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, latS))
    const clampN = Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, latN))
    const yS = Math.log(Math.tan(Math.PI / 4 + (clampS * D2R) / 2)) * EARTH
    const yN = Math.log(Math.tan(Math.PI / 4 + (clampN * D2R) / 2)) * EARTH
    const ySpan = Math.max(1e-9, yN - yS)
    return Math.max(0.5, Math.log2((WORLD_MERC * cssHeightPx) / (TILE_PX * ySpan)))
  }

  /** Device-pixel-ratio used to convert the canvas device-pixel buffer size back
   *  to CSS pixels. Read FROM the canvas (`canvas.width / clientWidth`) so it is the
   *  exact effDpr `resizeCanvas` sized the swapchain with — including the #1153 M3
   *  clamp, which can drop it below `min(devicePixelRatio, getMaxDpr())` when the
   *  device-pixel size would exceed `maxTextureDimension2D`. Re-deriving the
   *  quality-policy cap here would disagree with the actual buffer the moment the
   *  clamp engages, under-reporting the CSS viewport → over-zoomed fitBounds (#929 B
   *  single authority). The camera/view-matrix path works in CSS pixels (DPR-
   *  invariant, commit ee1f394), so panBy / fitBounds / getBounds must strip the DPR
   *  the device-pixel canvas.width carries. */
  private _dpr(canvas: HTMLCanvasElement | undefined): number {
    return canvas ? canvasEffectiveDpr(canvas) : effectiveDpr()
  }

  /** Whether the camera was explicitly positioned (hash / setView /
   *  pointer interaction) so the post-compile bounds-fit auto-snap
   *  no-ops. Owned here; XGISMap mirrors it via a get/set accessor for
   *  the diagnostics + characterization-test seam. */
  cameraExplicitlyPositioned = false
}
