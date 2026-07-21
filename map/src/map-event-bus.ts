// ═══ MapEventBus — map-level event listener state + dispatch ═══
//
// Extracted from map.ts (2026-06-19 runtime redesign §3.2 "MapEventBus").
// Owns the feature/pointer listener registry, the lifecycle/camera event
// registry, and the per-rAF camera-signature diff that drives
// movestart/move/moveend, zoomstart/zoom/zoomend, and idle.
// Behavior is a verbatim relocation of the former XGISMap methods —
// same execution order, same conditions, same event payloads.

import type { Camera } from './camera'
import {
  ListenerRegistry,
  MapEventRegistry,
  XGISMapEvent,
  isMapEventType,
  type XGISFeatureEvent,
  type XGISFeatureEventType,
  type XGISFeatureListener,
  type XGISMapErrorInfo,
  type XGISMapEventType,
  type XGISMapListener,
} from './layer'

/** Host hooks the event bus needs to read shared map state. */
export interface MapEventBusHost {
  /** Live camera (read every tick for signature diff). */
  readonly camera: Camera
  /** Current camera state for event payloads. */
  getCameraState(): { center: [number, number]; zoom: number; bearing: number; pitch: number }
  /** True when the render loop would draw this tick (idle gate). */
  shouldRenderThisFrame(): boolean
  /** The map instance — stamped as `target` on every XGISMapEvent. */
  readonly target: object
}

/** Map-level event listener state + dispatch extracted from XGISMap.
 *
 *  Owns:
 *   - mapListeners  (feature/pointer events: click, mousemove, …)
 *   - mapEventListeners (lifecycle/camera events: load, move*, zoom*, idle)
 *   - _loadFired one-shot guard
 *   - _moveActive / _zoomActive / _wasIdle transition state
 *   - _evtSig* camera-signature snapshot for the per-tick diff
 *
 *  Call `processCameraEvents()` once per rAF tick (before the render-skip
 *  gate) to drive the move/zoom/idle lifecycle events. */
export class MapEventBus {
  // Feature/pointer listener registry.
  readonly mapListeners = new ListenerRegistry()
  // Lifecycle/camera listener registry.
  readonly mapEventListeners = new MapEventRegistry()

  // One-shot `load` guard.
  _loadFired = false

  // Move/zoom/idle transition state.
  private _moveActive = false
  private _zoomActive = false
  private _wasIdle = false

  // Last camera signature for which lifecycle events were emitted. Kept
  // separate from renderFrame's `_lastSig*` so event logic is robust across
  // skipped frames.
  private _evtSigCX = NaN
  private _evtSigCY = NaN
  private _evtSigZoom = NaN
  private _evtSigBearing = NaN
  private _evtSigPitch = NaN

  constructor(private readonly host: MapEventBusHost) {}

  // ─── Camera event processing ────────────────────────────────────────────

  /** Drive movestart/move/moveend, zoomstart/zoom/zoomend, and idle off
   *  the camera signature, once per rAF tick. MapLibre semantics:
   *    - a "move" begins on the first changed frame (`movestart`), fires
   *      `move` every changed frame, and ends (`moveend`) the first frame
   *      the camera is unchanged again — regardless of pending tile work.
   *    - "zoom" likewise, gated on the zoom field alone.
   *    - `idle` fires once on the busy→idle transition: camera at rest
   *      AND no pending tile/label work AND no active move/zoom.
   *  Diffing the camera (not `_lastSig*`) means programmatic jumpTo and
   *  user drag/wheel both flow through here uniformly. */
  processCameraEvents(): void {
    const c = this.host.camera
    const cxChanged = c.centerX !== this._evtSigCX
    const cyChanged = c.centerY !== this._evtSigCY
    const bearingChanged = c.bearing !== this._evtSigBearing
    const pitchChanged = c.pitch !== this._evtSigPitch
    const zoomChanged = c.zoom !== this._evtSigZoom
    // First tick: seed the signature without firing (NaN !== anything).
    const seeded = Number.isFinite(this._evtSigCX)
    const moved =
      seeded && (cxChanged || cyChanged || bearingChanged || pitchChanged || zoomChanged)

    if (moved) {
      // Zoom start/continue (zoom is also a move in MapLibre).
      if (zoomChanged) {
        if (!this._zoomActive) {
          this._zoomActive = true
          this._fireMapEvent('zoomstart')
        }
      }
      if (!this._moveActive) {
        this._moveActive = true
        this._fireMapEvent('movestart')
      }
      if (zoomChanged) this._fireMapEvent('zoom')
      this._fireMapEvent('move')
    } else {
      // Camera at rest this tick — close out any open move/zoom.
      if (this._zoomActive) {
        this._zoomActive = false
        this._fireMapEvent('zoomend')
      }
      if (this._moveActive) {
        this._moveActive = false
        this._fireMapEvent('moveend')
      }
    }

    // Update the emitted-signature snapshot.
    this._evtSigCX = c.centerX
    this._evtSigCY = c.centerY
    this._evtSigZoom = c.zoom
    this._evtSigBearing = c.bearing
    this._evtSigPitch = c.pitch

    // Idle = nothing left to draw AND camera at rest AND no open gesture.
    // `shouldRenderThisFrame()` already folds in _needsRender,
    // _sceneHasAnimation, hasPendingSourceWork, and the camera/size diff.
    const idleNow = !this._moveActive && !this._zoomActive && !this.host.shouldRenderThisFrame()
    if (idleNow) {
      if (!this._wasIdle) {
        this._wasIdle = true
        this._fireMapEvent('idle')
      }
    } else {
      this._wasIdle = false
    }
  }

  // ─── Internal fire helpers ───────────────────────────────────────────────

  /** Build + dispatch a lifecycle/camera event from the current camera
   *  state. No-op without listeners so the per-frame path stays cheap. */
  _fireMapEvent(type: XGISMapEventType): void {
    if (!this.mapEventListeners.has(type)) return
    const cam = this.host.getCameraState()
    this.mapEventListeners.dispatch(
      new XGISMapEvent({
        type,
        target: this.host.target,
        center: cam.center,
        zoom: cam.zoom,
        bearing: cam.bearing,
        pitch: cam.pitch,
      }),
    )
  }

  /** Fire `load` exactly once, after the map has entered the render loop. */
  fireLoadEvent(): void {
    if (this._loadFired) return
    this._loadFired = true
    this._fireMapEvent('load')
  }

  /** Fire a map-level `'error'` event carrying the lifecycle-fault payload
   *  (phase/fatal/error) plus the current camera snapshot for uniformity with
   *  the other map events. No-op without listeners so the fault path stays cheap. */
  fireErrorEvent(info: XGISMapErrorInfo): void {
    if (!this.mapEventListeners.has('error')) return
    const cam = this.host.getCameraState()
    this.mapEventListeners.dispatch(
      new XGISMapEvent({
        type: 'error',
        target: this.host.target,
        center: cam.center,
        zoom: cam.zoom,
        bearing: cam.bearing,
        pitch: cam.pitch,
        phase: info.phase,
        fatal: info.fatal,
        error: info.error,
      }),
    )
  }

  /** Fire `backendresolved` once per successful boot with the resolved GPU
   *  backend, so a host can observe a silent WebGPU→WebGL2 auto-fallback (#1153
   *  M4). Stateless (unlike `load`): a device-lost recovery re-run re-fires it,
   *  correctly surfacing a flipped backend. No-op without listeners so the boot
   *  tail stays cheap. */
  fireBackendResolvedEvent(backend: 'webgpu' | 'webgl2'): void {
    if (!this.mapEventListeners.has('backendresolved')) return
    const cam = this.host.getCameraState()
    this.mapEventListeners.dispatch(
      new XGISMapEvent({
        type: 'backendresolved',
        target: this.host.target,
        center: cam.center,
        zoom: cam.zoom,
        bearing: cam.bearing,
        pitch: cam.pitch,
        backend,
      }),
    )
  }

  /** Internal: EventDispatcher calls this after a layer-level dispatch so
   *  map-level handlers see every hit. `event.defaultPrevented` carries
   *  through — a layer listener's preventDefault() suppresses this. */
  dispatchMapEvent(event: XGISFeatureEvent): void {
    if (event.defaultPrevented) return
    if (!this.mapListeners.has(event.type)) return
    this.mapListeners.dispatch(event, 'map')
  }

  // ─── Public event registration API ──────────────────────────────────────

  /** Map-level event delegation — fires for any layer hit (`target` = the
   *  hit layer, same `XGISFeatureEvent` shape). Layer-level listeners run
   *  first; their `preventDefault` suppresses the map-level dispatch. */
  addEventListener(
    type: XGISFeatureEventType,
    listener: XGISFeatureListener,
    options?: { signal?: AbortSignal; once?: boolean },
  ): void {
    this.mapListeners.add(type, listener, options)
  }

  removeEventListener(type: XGISFeatureEventType, listener: XGISFeatureListener): void {
    this.mapListeners.remove(type, listener)
  }

  /** Mapbox-API parity `on()`/`off()` aliases. Two disjoint event surfaces
   *  routed by name: feature/pointer events (click, mousemove, …) →
   *  `mapListeners` (XGISFeatureEvent, carries the hit feature);
   *  lifecycle/camera events (load, idle, move*, zoom*) →
   *  `mapEventListeners` (XGISMapEvent, carries the camera state).
   *  Unknown names warn once at the feature registry (layer.ts, P0-4). */
  on(type: XGISMapEventType, listener: XGISMapListener): void
  on(type: XGISFeatureEventType, listener: XGISFeatureListener): void
  on(
    type: XGISFeatureEventType | XGISMapEventType,
    listener: XGISFeatureListener | XGISMapListener,
  ): void {
    if (isMapEventType(type)) this.mapEventListeners.add(type, listener as XGISMapListener)
    else this.mapListeners.add(type, listener as XGISFeatureListener)
  }

  off(type: XGISMapEventType, listener: XGISMapListener): void
  off(type: XGISFeatureEventType, listener: XGISFeatureListener): void
  off(
    type: XGISFeatureEventType | XGISMapEventType,
    listener: XGISFeatureListener | XGISMapListener,
  ): void {
    if (isMapEventType(type)) this.mapEventListeners.remove(type, listener as XGISMapListener)
    else this.mapListeners.remove(type, listener as XGISFeatureListener)
  }

  once(type: XGISMapEventType, listener: XGISMapListener): void
  once(type: XGISFeatureEventType, listener: XGISFeatureListener): void
  once(
    type: XGISFeatureEventType | XGISMapEventType,
    listener: XGISFeatureListener | XGISMapListener,
  ): void {
    if (isMapEventType(type))
      this.mapEventListeners.add(type, listener as XGISMapListener, { once: true })
    else this.mapListeners.add(type, listener as XGISFeatureListener, { once: true })
  }
}
