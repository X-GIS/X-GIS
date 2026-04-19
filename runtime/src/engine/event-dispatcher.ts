// ═══ Pointer event dispatcher — pickAt → XGISFeatureEvent ═══
//
// Bridges the pointer events captured by the controller to the per-layer
// listener registries on XGISLayer. Owns the single piece of cross-frame
// state needed for hover semantics: the `(layerId, featureId)` tuple of
// whatever layer/feature was under the cursor on the previous frame, so
// `mouseenter` / `mouseleave` fire exactly once at boundary crossings.
//
// Async pickAt latency: WebGPU's copyTextureToBuffer + mapAsync is one
// frame round-trip (~16ms). Click handlers therefore fire ~1 frame after
// the physical click. That's the cost of correctness — sub-frame sync
// readback isn't a WebGPU primitive. Documented contract.
//
// Throughput: pointermove is rAF-coalesced. Multiple moves within the
// same frame collapse into one `pickAt`, scaled by display refresh
// (60Hz monitor → 60Hz hover, 120Hz → 120Hz). Hidden tabs skip work.

import type { XGISLayer, XGISFeature, XGISFeatureEventType } from './layer'
import { XGISFeatureEvent } from './layer'

export interface DispatcherDeps {
  /** Async pick at the given canvas-relative CSS coordinates. Returns
   *  null when the pixel doesn't carry a pickable layer. */
  pickAt(clientX: number, clientY: number): Promise<{ featureId: number; layerId: number; instanceId: number } | null>
  /** Reverse-resolve a layerId from the pick texture into its public
   *  XGISLayer wrapper. */
  getLayerById(layerId: number): XGISLayer | null
  /** Build the rich feature payload for a hit. The dispatcher doesn't
   *  know about source/property tables — `XGISMap` injects this. */
  buildFeature(layerId: number, featureId: number): XGISFeature | null
  /** Convert client-coordinates to longitude/latitude using the current
   *  camera projection. Returns null when the pixel is outside the
   *  projected globe (e.g., sphere edge in orthographic). */
  clientToLngLat(clientX: number, clientY: number): readonly [number, number] | null
  /** Canvas DOMRect for converting clientX/Y to pixel-relative coords. */
  getCanvasRect(): DOMRect
  /** Hook for map-level event delegation. Called after each layer-level
   *  dispatch — `event.defaultPrevented` carries through, so a layer
   *  handler can suppress the map-level fire by calling preventDefault. */
  dispatchMapEvent(event: import('./layer').XGISFeatureEvent): void
  /** Whether map-level has any listeners for `type`. Lets the dispatcher
   *  skip the pickAt/buildFeature path entirely when neither the
   *  topmost layer nor the map have a listener. */
  mapHasListeners(type: import('./layer').XGISFeatureEventType): boolean
}

export class EventDispatcher {
  /** Most recent hit observed by hover dispatch. Drives mouseenter /
   *  mouseleave boundary detection. `null` = pointer was over no
   *  pickable layer (or off-canvas). */
  private hoverPrev: { layerId: number; featureId: number } | null = null
  /** rAF handle for hover coalescing — set when a pointermove is
   *  pending dispatch this frame, cleared in the rAF callback. */
  private moveRafHandle: number | null = null
  /** Latest pointermove payload — overwritten until the next rAF
   *  flushes it. */
  private moveLatest: { x: number; y: number; ev: PointerEvent } | null = null

  constructor(private deps: DispatcherDeps) {}

  /** Called by the controller from `pointerup` after deadzone/drag
   *  filtering. Fires `click` on the topmost pickable layer at (x, y),
   *  if any. Also forwards to map-level delegation. */
  async handleClick(clientX: number, clientY: number, ev: PointerEvent): Promise<void> {
    await this.fireOnce('click', clientX, clientY, ev)
  }

  async handlePointerDown(clientX: number, clientY: number, ev: PointerEvent): Promise<void> {
    await this.fireOnce('pointerdown', clientX, clientY, ev)
  }

  async handlePointerUp(clientX: number, clientY: number, ev: PointerEvent): Promise<void> {
    await this.fireOnce('pointerup', clientX, clientY, ev)
  }

  async handleWheel(clientX: number, clientY: number, ev: WheelEvent): Promise<void> {
    await this.fireOnce('wheel', clientX, clientY, ev)
  }

  /** Called by the controller from every `pointermove`. Coalesces via
   *  requestAnimationFrame so multiple intra-frame moves trigger at
   *  most one `pickAt`. */
  handleMove(clientX: number, clientY: number, ev: PointerEvent): void {
    this.moveLatest = { x: clientX, y: clientY, ev }
    if (this.moveRafHandle !== null) return
    this.moveRafHandle = requestAnimationFrame(() => {
      this.moveRafHandle = null
      const queued = this.moveLatest
      this.moveLatest = null
      if (queued) void this.flushMove(queued.x, queued.y, queued.ev)
    })
  }

  /** Pointer left the canvas entirely. Force a `mouseleave` on whatever
   *  was hovered so layers don't get stuck thinking the cursor is still
   *  over them. */
  handlePointerLeave(ev: PointerEvent): void {
    const prev = this.hoverPrev
    this.hoverPrev = null
    if (!prev) return
    const layer = this.deps.getLayerById(prev.layerId)
    if (!layer) return
    if (!layer.hasListeners('mouseleave') && !this.deps.mapHasListeners('mouseleave')) return
    const feature = this.deps.buildFeature(prev.layerId, prev.featureId)
    if (!feature) return
    const event = this.makeEvent('mouseleave', layer, feature, ev.clientX, ev.clientY, ev)
    if (!event) return
    layer.dispatchEvent(event)
    this.deps.dispatchMapEvent(event)
  }

  /** Shared layer + map dispatch for a one-shot event type (click /
   *  pointerdown / pointerup / wheel). Single pickAt round-trip; layer
   *  dispatch first, then map-level (suppressed on preventDefault). */
  private async fireOnce(
    type: import('./layer').XGISFeatureEventType,
    clientX: number, clientY: number, ev: PointerEvent | WheelEvent,
  ): Promise<void> {
    const hit = await this.deps.pickAt(clientX, clientY)
    if (!hit) return
    const layer = this.deps.getLayerById(hit.layerId)
    if (!layer) return
    const layerListens = layer.hasListeners(type)
    const mapListens = this.deps.mapHasListeners(type)
    if (!layerListens && !mapListens) return
    const feature = this.deps.buildFeature(hit.layerId, hit.featureId)
    if (!feature) return
    const event = this.makeEvent(type, layer, feature, clientX, clientY, ev)
    if (!event) return
    if (layerListens) layer.dispatchEvent(event)
    if (mapListens) this.deps.dispatchMapEvent(event)
  }

  private async flushMove(clientX: number, clientY: number, ev: PointerEvent): Promise<void> {
    const hit = await this.deps.pickAt(clientX, clientY)
    const current = hit ? { layerId: hit.layerId, featureId: hit.featureId } : null
    const prev = this.hoverPrev
    const changed = !sameHover(prev, current)

    const fireHover = (
      type: import('./layer').XGISFeatureEventType,
      hit: { layerId: number; featureId: number },
    ) => {
      const layer = this.deps.getLayerById(hit.layerId)
      if (!layer) return
      const layerListens = layer.hasListeners(type)
      const mapListens = this.deps.mapHasListeners(type)
      if (!layerListens && !mapListens) return
      const f = this.deps.buildFeature(hit.layerId, hit.featureId)
      if (!f) return
      const e = this.makeEvent(type, layer, f, clientX, clientY, ev)
      if (!e) return
      if (layerListens) layer.dispatchEvent(e)
      if (mapListens) this.deps.dispatchMapEvent(e)
    }

    if (changed && prev) fireHover('mouseleave', prev)
    if (changed && current) fireHover('mouseenter', current)
    if (current) fireHover('mousemove', current)

    this.hoverPrev = current
  }

  private makeEvent(
    type: XGISFeatureEventType,
    target: XGISLayer,
    feature: XGISFeature,
    clientX: number,
    clientY: number,
    originalEvent: PointerEvent | WheelEvent,
  ): XGISFeatureEvent | null {
    const rect = this.deps.getCanvasRect()
    const pixel: readonly [number, number] = [clientX - rect.left, clientY - rect.top]
    const coordinate = this.deps.clientToLngLat(clientX, clientY) ?? [NaN, NaN] as const
    return new XGISFeatureEvent({
      type, target, feature, coordinate, pixel, clientX, clientY, originalEvent,
    })
  }
}

function sameHover(
  a: { layerId: number; featureId: number } | null,
  b: { layerId: number; featureId: number } | null,
): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.layerId === b.layerId && a.featureId === b.featureId
}
