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

import { Camera } from './projection/camera'
import { MERCATOR_LAT_LIMIT } from './projection/projection'
import { WORLD_MERC, TILE_PX } from './gpu/gpu-shared'
import { lonLatToMercator } from '../loader/geojson'

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
}

export class CameraController {
  private readonly camera: Camera
  private readonly invalidate: () => void
  private readonly getCanvas: () => HTMLCanvasElement
  private readonly getCtxCanvas: () => HTMLCanvasElement | undefined

  constructor(camera: Camera, deps: CameraControllerDeps) {
    this.camera = camera
    this.invalidate = deps.invalidate
    this.getCanvas = deps.getCanvas
    this.getCtxCanvas = deps.getCtxCanvas
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
      console.warn(`[X-GIS] setCenter: non-finite (lon=${lon}, lat=${lat}); ignored.`)
      return
    }
    // Honor setMaxBounds: clamp the input lon/lat to the bbox before
    // projecting. Without this, jumpTo could escape the constraint.
    let cLon = lon, cLat = lat
    if (this._maxBounds) {
      cLon = Math.max(this._maxBounds.west, Math.min(this._maxBounds.east, cLon))
      cLat = Math.max(this._maxBounds.south, Math.min(this._maxBounds.north, cLat))
    }
    // Clamp lat to Mercator-safe limit; lon wraps in renderFrame.
    const clampedLat = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, cLat))
    const [mx, my] = lonLatToMercator(cLon, clampedLat)
    this.camera.centerX = mx
    this.camera.centerY = my
    this.invalidate()
  }

  setZoom(zoom: number): void {
    if (!Number.isFinite(zoom)) {
      console.warn(`[X-GIS] setZoom: non-finite (${zoom}); ignored.`)
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
      console.warn(`[X-GIS] setMinZoom: non-finite (${z}); ignored.`)
      return
    }
    this.camera.minZoom = Math.max(0, Math.min(22, z))
    if (this.camera.zoom < this.camera.minZoom) {
      this.camera.zoom = this.camera.minZoom
      this.invalidate()
    }
  }
  setMaxZoom(z: number): void {
    if (!Number.isFinite(z)) {
      console.warn(`[X-GIS] setMaxZoom: non-finite (${z}); ignored.`)
      return
    }
    this.camera.maxZoom = Math.max(0, Math.min(22, z))
    if (this.camera.zoom > this.camera.maxZoom) {
      this.camera.zoom = this.camera.maxZoom
      this.invalidate()
    }
  }
  getMinZoom(): number { return this.camera.minZoom }
  getMaxZoom(): number { return this.camera.maxZoom }

  /** Mapbox-API parity: increment / decrement zoom by 1.
   *  Animation arg is accepted but ignored (no transition infra) —
   *  matches MapLibre signature so callers can port code unchanged.
   *  Result is clamped to [minZoom, maxZoom]. */
  zoomIn(): void { this.setZoom(this.camera.zoom + 1) }
  zoomOut(): void { this.setZoom(this.camera.zoom - 1) }

  /** Mapbox-API parity: constrain pan to a lon/lat bounding box.
   *  Subsequent setCenter / jumpTo / user pan gestures clamp the
   *  camera center inside the bbox so the view can't drift outside
   *  the deployment's intended area. Pass `null` to clear. */
  private _maxBounds: { west: number; south: number; east: number; north: number } | null = null
  setMaxBounds(bounds: [[number, number], [number, number]] | null): void {
    if (bounds === null) {
      this._maxBounds = null
      return
    }
    const [[w, s], [e, n]] = bounds
    if (!Number.isFinite(w) || !Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(n)
        || s > n || s < -90 || n > 90) {
      console.warn(`[X-GIS] setMaxBounds: invalid bounds (${w},${s})-(${e},${n}); ignored.`)
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
      console.warn(`[X-GIS] setMaxBounds: antimeridian-crossing bbox (west=${w} > east=${e}) not supported; ignored.`)
      return
    }
    this._maxBounds = { west: w, south: s, east: e, north: n }
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
    return [[b.west, b.south], [b.east, b.north]]
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
    const cssW = canvas?.width ?? 800
    const cssH = canvas?.height ?? 600
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
    return [[west, south], [east, north]]
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
    if (!Number.isFinite(w) || !Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(n)
        || s > n) {
      console.warn(`[X-GIS] fitBounds: invalid bounds (${w},${s})-(${e},${n}); ignored.`)
      return
    }
    const centerLon = (w + e) / 2
    const centerLat = (s + n) / 2
    const lonSpan = Math.max(1e-9, e - w)
    const canvasW = (this.getCtxCanvas()?.width ?? 800) - (opts.padding ?? 0) * 2
    const cssWidthPx = canvasW > 0 ? canvasW : 800
    const zoom = this._fitZoomToLonSpan(lonSpan, cssWidthPx)
    this.jumpTo({
      center: [centerLon, centerLat],
      zoom,
      bearing: opts.bearing ?? 0,
      pitch: opts.pitch ?? 0,
    })
  }

  /** Mapbox-API parity: `easeTo` and `flyTo` are the animated variants
   *  of jumpTo in MapLibre GL JS. X-GIS has no transition infra yet, so
   *  both alias to jumpTo (instant) — same final camera state, just no
   *  smooth interpolation along the way. Callers porting MapLibre code
   *  compile unchanged; behaviour degrades gracefully to a jump.
   *
   *  When animation lands, these become real eased / fly transitions
   *  and the alias is removed. */
  easeTo(opts: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number; duration?: number; easing?: unknown }): void {
    this.jumpTo({ center: opts.center, zoom: opts.zoom, bearing: opts.bearing, pitch: opts.pitch })
  }
  flyTo(opts: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number; duration?: number; speed?: number; curve?: number }): void {
    this.jumpTo({ center: opts.center, zoom: opts.zoom, bearing: opts.bearing, pitch: opts.pitch })
  }

  /** Mapbox-API parity: pan the map by an offset in CSS pixels.
   *  Positive dx moves the map LEFT (camera moves RIGHT in world);
   *  positive dy moves the map UP (camera moves DOWN). Honors the
   *  current bearing so a +dx with bearing=90 pans north, not east. */
  panBy(offset: [number, number]): void {
    if (!Number.isFinite(offset[0]) || !Number.isFinite(offset[1])) {
      console.warn(`[X-GIS] panBy: non-finite offset (${offset[0]}, ${offset[1]}); ignored.`)
      return
    }
    const mpp = (WORLD_MERC / TILE_PX) / Math.pow(2, this.camera.zoom)
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 4) : 1
    // CSS-px → Mercator meters at current zoom. dpr scales the CSS-px
    // input into the device-px buffer the camera works in.
    const dxMerc = offset[0] * mpp * dpr
    const dyMerc = offset[1] * mpp * dpr
    // Bearing rotation: screen-space +x is the map's east only when
    // bearing=0. Rotate the offset back into the map's reference frame.
    const bearingRad = this.camera.bearing * Math.PI / 180
    const cos = Math.cos(bearingRad), sin = Math.sin(bearingRad)
    const dxMap = dxMerc * cos - dyMerc * sin
    const dyMap = dxMerc * sin + dyMerc * cos
    // Route the result through setCenter so the maxBounds clamp
    // applies. Convert the new Mercator center back to lon/lat first
    // since setCenter expects lon/lat, then setCenter re-projects.
    if (this._maxBounds) {
      const EARTH = 6378137, D2R = Math.PI / 180
      const newMercX = this.camera.centerX + dxMap
      const newMercY = this.camera.centerY - dyMap // screen-y inverted
      const newLon = newMercX / (D2R * EARTH)
      const newLatRad = 2 * Math.atan(Math.exp(newMercY / EARTH)) - Math.PI / 2
      const newLat = newLatRad * 180 / Math.PI
      this.setCenter(newLon, newLat)
    } else {
      this.camera.centerX += dxMap
      this.camera.centerY -= dyMap
      this.invalidate()
    }
  }

  setBearing(bearing: number): void {
    if (!Number.isFinite(bearing)) {
      console.warn(`[X-GIS] setBearing: non-finite (${bearing}); ignored.`)
      return
    }
    // Wrap to [0, 360). Negative bearings wrap to positive equivalent.
    this.camera.bearing = ((bearing % 360) + 360) % 360
    this.invalidate()
  }

  setPitch(pitch: number): void {
    if (!Number.isFinite(pitch)) {
      console.warn(`[X-GIS] setPitch: non-finite (${pitch}); ignored.`)
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
  jumpTo(opts: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void {
    if (opts.center) {
      const [lon, lat] = opts.center
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        console.warn(`[X-GIS] jumpTo: non-finite center (${lon}, ${lat}); skipped.`)
      } else {
        // Honor maxBounds clamp first.
        let cLon = lon, cLat = lat
        if (this._maxBounds) {
          cLon = Math.max(this._maxBounds.west, Math.min(this._maxBounds.east, cLon))
          cLat = Math.max(this._maxBounds.south, Math.min(this._maxBounds.north, cLat))
        }
        const clampedLat = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, cLat))
        const [mx, my] = lonLatToMercator(cLon, clampedLat)
        this.camera.centerX = mx
        this.camera.centerY = my
      }
    }
    if (opts.zoom !== undefined) {
      if (!Number.isFinite(opts.zoom)) {
        console.warn(`[X-GIS] jumpTo: non-finite zoom (${opts.zoom}); skipped.`)
      } else {
        this.camera.zoom = Math.max(this.camera.minZoom, Math.min(this.camera.maxZoom, opts.zoom))
      }
    }
    if (opts.bearing !== undefined) {
      if (!Number.isFinite(opts.bearing)) {
        console.warn(`[X-GIS] jumpTo: non-finite bearing (${opts.bearing}); skipped.`)
      } else {
        this.camera.bearing = ((opts.bearing % 360) + 360) % 360
      }
    }
    if (opts.pitch !== undefined) {
      if (!Number.isFinite(opts.pitch)) {
        console.warn(`[X-GIS] jumpTo: non-finite pitch (${opts.pitch}); skipped.`)
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
  getZoom(): number { return this.camera.zoom }
  getBearing(): number { return this.camera.bearing }
  getPitch(): number { return this.camera.pitch }

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
    const EARTH_RADIUS = 6378137
    const DEG2RAD = Math.PI / 180
    const cx = Number.isFinite(this.camera.centerX) ? this.camera.centerX : 0
    const cy = Number.isFinite(this.camera.centerY) ? this.camera.centerY : 0
    const lon = cx / (DEG2RAD * EARTH_RADIUS)
    const latRad = 2 * Math.atan(Math.exp(cy / EARTH_RADIUS)) - Math.PI / 2
    const lat = latRad / DEG2RAD
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

  /** Whether the camera was explicitly positioned (hash / setView /
   *  pointer interaction) so the post-compile bounds-fit auto-snap
   *  no-ops. Owned here; XGISMap mirrors it via a get/set accessor for
   *  the diagnostics + characterization-test seam. */
  cameraExplicitlyPositioned = false
}
