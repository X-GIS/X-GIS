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
  pickAt(
    clientX: number,
    clientY: number,
  ): Promise<{ featureId: number; layerId: number; instanceId: number } | null>
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
  /** Could ANY registered layer fire `type`? Answers the pre-pick gate
   *  WITHOUT a hit — which is the whole point: the per-layer check below
   *  needs `hit.layerId`, so asking only that question forced the pick to
   *  run first and made the "skip the pickAt path entirely" contract above
   *  unreachable. A map with no feature listeners now never pays a readback.
   *  Required (not optional) on purpose: an optional dep that a caller
   *  forgets to wire would silently make the gate vacuous. */
  anyLayerListens(type: import('./layer').XGISFeatureEventType): boolean
  /** Optional (#1263) — notifies the host when the hovered-feature state
   *  flips (no feature ⇄ a feature under the pointer), so it can drive the
   *  built-in `pointer` cursor. Fires only on a boolean transition, and only
   *  while hover picking actually runs, so it rides the same listener gate:
   *  a map with no hover listeners never picks, so it never reports hover. */
  onHoverActiveChange?(active: boolean): void
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
  /** rAF handle for wheel coalescing. Separate from `moveRafHandle` (the
   *  payload types differ; one handle for both would drop whichever arrived
   *  first). */
  private wheelRafHandle: number | null = null
  /** Latest wheel payload — overwritten until the next rAF flushes it. */
  private wheelLatest: { x: number; y: number; ev: WheelEvent } | null = null

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

  /** Coalesced like `handleMove` — a trackpad emits wheel events far faster
   *  than the ~1-frame `pickAt` readback can answer, so an unbatched pick per
   *  event piles up in-flight readbacks that `mapAsync` then REJECTS ("still
   *  mapped (rapid re-pick)", interaction-controller.ts), silently dropping the
   *  very events it was trying to serve. One pick per frame, latest wins.
   *
   *  `wheel` as a FEATURE event is an X-GIS extension — MapLibre/Mapbox scope
   *  wheel to the map only, never to layers — so no parity contract constrains
   *  this. Camera zoom is unaffected: the controller consumes raw deltas on its
   *  own path and never goes through here. Known cost: a listener accumulating
   *  `deltaY` sees only the last event's delta per frame, not the sum. */
  handleWheel(clientX: number, clientY: number, ev: WheelEvent): void {
    this.wheelLatest = { x: clientX, y: clientY, ev }
    if (this.wheelRafHandle !== null) return
    this.wheelRafHandle = requestAnimationFrame(() => {
      this.wheelRafHandle = null
      const queued = this.wheelLatest
      this.wheelLatest = null
      if (queued) void this.fireOnce('wheel', queued.x, queued.y, queued.ev)
    })
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

  /** Teardown — cancel any pending move-coalescing rAF so its callback
   *  can't fire `pickAt` against a destroyed device, and drop the
   *  cross-frame hover/move state so nothing is GC-pinned. Idempotent. */
  destroy(): void {
    if (this.moveRafHandle !== null) {
      cancelAnimationFrame(this.moveRafHandle)
      this.moveRafHandle = null
    }
    // Same reason as the move handle: a pending wheel rAF would otherwise fire
    // `pickAt` against a destroyed device.
    if (this.wheelRafHandle !== null) {
      cancelAnimationFrame(this.wheelRafHandle)
      this.wheelRafHandle = null
    }
    this.moveLatest = null
    this.wheelLatest = null
    this.hoverPrev = null
  }

  /** Pointer left the canvas entirely. Force a `mouseleave` on whatever
   *  was hovered so layers don't get stuck thinking the cursor is still
   *  over them. Cancel any pending move-coalescing rAF so its callback
   *  cannot fire spurious mouseenter/mousemove after the leave. */
  handlePointerLeave(ev: PointerEvent): void {
    if (this.moveRafHandle !== null) {
      cancelAnimationFrame(this.moveRafHandle)
      this.moveRafHandle = null
    }
    this.moveLatest = null
    const prev = this.hoverPrev
    this.hoverPrev = null
    // Pointer left the canvas → nothing is hovered; reset the cursor even if
    // this layer has no `mouseleave` listener (cursor ≠ event dispatch).
    if (prev) this.deps.onHoverActiveChange?.(false)
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
    clientX: number,
    clientY: number,
    ev: PointerEvent | WheelEvent,
  ): Promise<void> {
    // PRE-PICK GATE. `pickAt` is a GPU readback (copyTextureToBuffer + submit +
    // await mapAsync — one frame round-trip, see the header), so it must not run
    // to discover that nobody was listening. This is a COARSE "could anyone fire
    // this?" test; the per-layer check below still decides whether the layer we
    // actually HIT listens, and must stay.
    const mapListens = this.deps.mapHasListeners(type)
    if (!mapListens && !this.deps.anyLayerListens(type)) return
    const hit = await this.deps.pickAt(clientX, clientY)
    if (!hit) return
    const layer = this.deps.getLayerById(hit.layerId)
    if (!layer) return
    const layerListens = layer.hasListeners(type)
    // NOT redundant with the gate above: `anyLayerListens` says SOME layer
    // listens; this says THE HIT layer does. Deleting it fires events at layers
    // that never registered one.
    if (!layerListens && !mapListens) return
    const feature = this.deps.buildFeature(hit.layerId, hit.featureId)
    if (!feature) return
    const event = this.makeEvent(type, layer, feature, clientX, clientY, ev)
    if (!event) return
    if (layerListens) layer.dispatchEvent(event)
    if (mapListens) this.deps.dispatchMapEvent(event)
  }

  private async flushMove(clientX: number, clientY: number, ev: PointerEvent): Promise<void> {
    // Same pre-pick gate as fireOnce, for the same reason — and this path matters
    // MORE: rAF-coalescing caps it at one readback per FRAME, so a map with no
    // hover listeners was paying a GPU round-trip continuously for the whole time
    // the pointer moved, not just in wheel bursts.
    const hover: XGISFeatureEventType[] = ['mouseenter', 'mouseleave', 'mousemove']
    if (!hover.some((t) => this.deps.mapHasListeners(t) || this.deps.anyLayerListens(t))) {
      // Reset, don't just return: a stale `hoverPrev` would make the first flush
      // after a listener IS registered diff against a hit from long ago — firing
      // a phantom `mouseleave` for a feature the pointer left ages back.
      if (this.hoverPrev !== null) this.deps.onHoverActiveChange?.(false)
      this.hoverPrev = null
      return
    }
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
    // Cursor hook (#1263): report only the null ⇄ non-null transition, so the
    // built-in `pointer` cursor tracks whether ANY feature is under the pointer
    // (independent of which listeners fired above).
    if ((prev !== null) !== (current !== null)) this.deps.onHoverActiveChange?.(current !== null)
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
    const coordinate = this.deps.clientToLngLat(clientX, clientY) ?? ([NaN, NaN] as const)
    return new XGISFeatureEvent({
      type,
      target,
      feature,
      coordinate,
      pixel,
      clientX,
      clientY,
      originalEvent,
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
