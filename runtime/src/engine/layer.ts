// ═══ Layer + Layer Style — DOM-inspired API for X-GIS ═══
//
// Mental model: `map.getLayer('borders')` is `document.getElementById`,
// `layer.style.opacity = 0.5` is `element.style.opacity = '0.5'`. The
// .style proxy is a typed object (not a JS Proxy) so setters validate
// and IDE autocomplete works.
//
// Pick texture encoding (LayerIdRegistry below): `pickAt()` reads
// (R, G) from an RG32Uint texture: R = featureId, G = (instanceId<<16)
// | layerId. layerId disambiguates which X-GIS layer drew the topmost
// pixel under the cursor — featureId alone can't tell two layers from
// different sources apart.
//
// IDs are u16, assigned in `addLayer()` registration order, stable for
// the lifetime of the layer (style toggles, animation, restyle never
// reassign). ID 0 is reserved as the "no layer" sentinel — `pickAt()`
// returns null for layerId === 0. `clearLayers()` (called on re-
// projection rebuild) resets the registry; re-registration in the
// same order produces the same IDs.
//
// Phase 2 introduces XGISLayer + XGISLayerStyle (this file). Phase 3
// adds the `pointerEvents:none` pipeline-variant pathway (writeMask:0
// on the pick attachment). Phase 4 adds addEventListener.

import type { ShowCommand } from './render/renderer'
import { parseHexColor as parseHexColorRaw } from './feature-helpers'

/** Wrapper that returns `null` on parse failure so the setters can
 *  short-circuit without touching paintShapes when given a malformed
 *  hex. The raw helper throws / returns garbage on bad input. */
function parseHexColor(
  hex: string,
): readonly [number, number, number, number] | null {
  if (typeof hex !== 'string' || hex.length === 0) return null
  // Reject non-hex shapes (e.g. CSS name 'red', empty, malformed
  // length). parseHexColorRaw silently returns [0,0,0,1] for anything
  // it doesn't recognise — letting that opaque-black sentinel flow
  // through to the renderer would silently corrupt the layer colour.
  // Mirror of the CSS spec hex pattern: #rgb / #rgba / #rrggbb /
  // #rrggbbaa.
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) return null
  try {
    return parseHexColorRaw(hex)
  } catch {
    return null
  }
}

const MAX_LAYER_ID = 0xffff

export class LayerIdRegistry {
  private next = 1
  private byName = new Map<string, number>()
  private byId = new Map<number, string>()

  /** Allocate (or return existing) layer ID for `name`. Same name registered
   *  twice returns the same ID — handles the case where the compiler emits
   *  a single `layer foo` that fan-outs to fill + stroke shows. */
  register(name: string): number {
    const existing = this.byName.get(name)
    if (existing !== undefined) return existing
    if (this.next > MAX_LAYER_ID) {
      throw new Error(`[X-GIS] LayerIdRegistry exhausted: more than ${MAX_LAYER_ID} layers`)
    }
    const id = this.next++
    this.byName.set(name, id)
    this.byId.set(id, name)
    return id
  }

  /** Reverse lookup: ID → layer name. Returns undefined for the sentinel
   *  ID 0 or any ID not currently registered. */
  getName(id: number): string | undefined {
    return this.byId.get(id)
  }

  /** Forward lookup: name → ID, or undefined if not registered. */
  getId(name: string): number | undefined {
    return this.byName.get(name)
  }

  /** Wipe the registry. Called from `XGISMap.clearLayers()` so re-projection
   *  rebuilds get a fresh deterministic ID assignment. */
  reset(): void {
    this.next = 1
    this.byName.clear()
    this.byId.clear()
  }

  /** Pack (instanceId, layerId) into the u32 written to the pick texture's
   *  G channel. Mirrors the decode in `map.pickAt()`. */
  static pack(layerId: number, instanceId = 0): number {
    return ((instanceId & 0xffff) << 16) | (layerId & 0xffff)
  }

  /** Decode a packed G-channel u32 into { layerId, instanceId }. */
  static unpack(packed: number): { layerId: number; instanceId: number } {
    return { layerId: packed & 0xffff, instanceId: (packed >>> 16) & 0xffff }
  }
}

// ═══ XGISLayer + XGISLayerStyle ═══════════════════════════════════
//
// `map.getLayer(name)` returns an `XGISLayer`. The wrapper holds a
// reference to the underlying `ShowCommand` (the same object VTR /
// classifier read every frame) and an invalidation callback that wakes
// the render loop when a style changes.
//
// Styling model:
//
//   - Setters mutate `show.<prop>` directly so VTR's per-frame reads
//     pick up the change on the next frame (no rebuild). The first
//     mutation per property snapshots the compiled default into
//     `_defaults` so `resetStyle(prop)` can restore it.
//   - `pointerEvents` is stored on the show today but is a no-op until
//     Phase 3 wires the writeMask:0 pipeline variant. Phase 2 ships it
//     so the API surface is stable from day one.
//   - `Object.assign(layer.style, { opacity: 0.5, fill: '#ff0000' })`
//     works because each property is a real accessor.

export type PointerEvents = 'auto' | 'none'

/** Public (CSS-like) style property names. Excludes private accessor
 *  fields on `XGISLayerStyle`. */
export type XGISLayerStyleKey =
  | 'opacity' | 'fill' | 'stroke' | 'strokeWidth'
  | 'visible' | 'pointerEvents' | 'extrude' | 'extrudeBase'

export interface XGISFeatureEventInit {
  // Phase 4 will populate this with click / mouseenter / mouseleave /
  // mousemove + the XGISFeatureEvent shape. Phase 2 keeps an empty
  // listener registry so addEventListener doesn't throw.
}

type StyleHost = {
  show: ShowCommand
  invalidate: () => void
}

export class XGISLayerStyle {
  /** Snapshot of compiled defaults captured on first mutation per prop,
   *  so `resetStyle` can restore them without round-tripping through
   *  the compiler. Keys mirror the public CSS-like names below. */
  private _defaults: Partial<Record<XGISLayerStyleKey, unknown>> = {}

  constructor(private host: StyleHost) {}

  private snapshot<K extends XGISLayerStyleKey>(key: K, current: unknown): void {
    if (!(key in this._defaults)) this._defaults[key] = current
  }

  get opacity(): number { return this.host.show.opacity ?? 1 }
  set opacity(v: number) {
    this.snapshot('opacity', this.host.show.opacity ?? 1)
    this.host.show.opacity = v
    // bucket-scheduler reads `paintShapes.opacity` per-frame, not the
    // flat `show.opacity` field. Update both so the WebGPU draw path
    // picks up the imperative override. (Was silently ineffective
    // post-Step-1d before this commit.)
    this.host.show.paintShapes.opacity = { kind: 'constant', value: v }
    this.host.invalidate()
  }

  get fill(): string | null { return this.host.show.fill }
  set fill(v: string | null) {
    // Validate BEFORE the snapshot+write: if hex parse fails, keep the
    // previous state so show.fill and paintShapes.fill stay in sync.
    // Pre-fix an unparseable colour (e.g. CSS name 'red' that the
    // runtime parser doesn't know) updated show.fill but left
    // paintShapes.fill at the old value — getters then reported the
    // new string while the renderer still drew the old colour.
    if (v !== null && parseHexColor(v) === null) return
    this.snapshot('fill', this.host.show.fill)
    this.host.show.fill = v
    // paintShapes.fill is the truth-of-record for the WebGPU draw path.
    // Hex → RGBA tuple; `null` clears the shape.
    if (v === null) {
      this.host.show.paintShapes.fill = null
    } else {
      const rgba = parseHexColor(v)!
      this.host.show.paintShapes.fill = { kind: 'constant', value: rgba }
    }
    this.host.invalidate()
  }

  get stroke(): string | null { return this.host.show.stroke }
  set stroke(v: string | null) {
    // Mirror of the fill setter — validate first to keep show.stroke +
    // paintShapes.stroke in sync.
    if (v !== null && parseHexColor(v) === null) return
    this.snapshot('stroke', this.host.show.stroke)
    this.host.show.stroke = v
    if (v === null) {
      this.host.show.paintShapes.stroke = null
    } else {
      const rgba = parseHexColor(v)!
      this.host.show.paintShapes.stroke = { kind: 'constant', value: rgba }
    }
    this.host.invalidate()
  }

  get strokeWidth(): number { return this.host.show.strokeWidth }
  set strokeWidth(v: number) {
    this.snapshot('strokeWidth', this.host.show.strokeWidth)
    this.host.show.strokeWidth = v
    this.host.show.paintShapes.strokeWidth = { kind: 'constant', value: v }
    this.host.invalidate()
  }

  get visible(): boolean { return this.host.show.visible }
  set visible(v: boolean) {
    this.snapshot('visible', this.host.show.visible)
    this.host.show.visible = v
    this.host.invalidate()
  }

  /** 3D extrusion height in metres for the polygon layer. Read returns
   *  the constant value when the compiled extrude shape is uniform
   *  (`kind: 'constant'`), or `null` when the layer is flat / per-feature
   *  driven. Set accepts a number to force a constant height, or `null`
   *  to flatten the layer. Per-feature `extrude.kind: 'feature'` shapes
   *  (the typical building-height pattern) remain untouched by API
   *  mutation — the per-feature AST is data-driven and survives style
   *  edits independently. */
  get extrude(): number | null {
    const e = this.host.show.extrude
    if (e.kind === 'constant') return e.value
    return null
  }
  set extrude(v: number | null) {
    this.snapshot('extrude', this.host.show.extrude)
    if (v === null) {
      this.host.show.extrude = { kind: 'none' }
    } else {
      this.host.show.extrude = { kind: 'constant', value: v }
    }
    this.host.invalidate()
  }

  /** Companion to `extrude` — the BASE z of the wall (Mapbox
   *  `fill-extrusion-base`). Combined with `extrude`, this carves out a
   *  `min_height` podium for buildings: walls run from `extrudeBase` to
   *  `extrude` metres. Read/write contract identical to `extrude`. */
  get extrudeBase(): number | null {
    const e = this.host.show.extrudeBase
    if (e.kind === 'constant') return e.value
    return null
  }
  set extrudeBase(v: number | null) {
    this.snapshot('extrudeBase', this.host.show.extrudeBase)
    if (v === null) {
      this.host.show.extrudeBase = { kind: 'none' }
    } else {
      this.host.show.extrudeBase = { kind: 'constant', value: v }
    }
    this.host.invalidate()
  }

  get pointerEvents(): PointerEvents {
    return (this.host.show.pointerEvents ?? 'auto') as PointerEvents
  }
  set pointerEvents(v: PointerEvents) {
    if (v !== 'auto' && v !== 'none') {
      throw new TypeError(`pointerEvents must be 'auto' or 'none' (got ${String(v)})`)
    }
    this.snapshot('pointerEvents', this.host.show.pointerEvents ?? 'auto')
    this.host.show.pointerEvents = v
    // No pipeline-cache invalidation needed: MapRenderer keeps both
    // pickable and writeMask:0 mirrors live, and the bucket scheduler
    // picks the right one per-frame based on `show.pointerEvents`.
    // Just wake the render loop so the next frame redispatches.
    this.host.invalidate()
  }

  /** Restore one property (or all) to compiled default. Properties never
   *  set via `style` are no-ops. */
  reset(key?: XGISLayerStyleKey): void {
    const restore = (k: XGISLayerStyleKey) => {
      if (!(k in this._defaults)) return
      // Bypass the snapshot logic — we're explicitly going back to the
      // compiled value, so direct assignment is the right move.
      ;(this.host.show as Record<string, unknown>)[k as string] = this._defaults[k]
      delete this._defaults[k]
    }
    if (key) restore(key)
    else for (const k of Object.keys(this._defaults) as (XGISLayerStyleKey)[]) restore(k)
    this.host.invalidate()
  }
}

export type XGISFeatureEventType =
  | 'click' | 'mouseenter' | 'mouseleave' | 'mousemove'
  | 'pointerdown' | 'pointerup' | 'wheel'

/** Lightweight feature snapshot delivered to event listeners. `geometry`
 *  is intentionally not surfaced in Phase 4 — pickAt only returns IDs,
 *  and reconstructing GeoJSON geometry from the GPU tile cache is a
 *  Phase 5 concern. Consumers that need geometry should index it by
 *  `id` against their own data source. */
export interface XGISFeature {
  /** Stable feature ID as encoded into the GPU pick texture. Matches the
   *  `feature.id` field on the source GeoJSON when present, otherwise
   *  falls back to `properties.id` or the array index. */
  readonly id: number
  /** DSL source name (`source <name> { ... }`). */
  readonly source: string
  /** DSL layer name (`layer <name> { ... }`). */
  readonly layer: string
  /** Feature properties as authored in GeoJSON. Empty object when the
   *  source has no property table or the ID can't be resolved. */
  readonly properties: Record<string, unknown>
}

export class XGISFeatureEvent {
  readonly type: XGISFeatureEventType
  readonly target: XGISLayer
  readonly currentTarget: XGISLayer
  readonly feature: XGISFeature
  readonly coordinate: readonly [number, number]
  readonly pixel: readonly [number, number]
  readonly clientX: number
  readonly clientY: number
  readonly originalEvent: PointerEvent | WheelEvent
  readonly timeStamp: number
  private _defaultPrevented = false

  constructor(init: {
    type: XGISFeatureEventType
    target: XGISLayer
    feature: XGISFeature
    coordinate: readonly [number, number]
    pixel: readonly [number, number]
    clientX: number
    clientY: number
    originalEvent: PointerEvent | WheelEvent
  }) {
    this.type = init.type
    this.target = init.target
    this.currentTarget = init.target
    this.feature = init.feature
    this.coordinate = init.coordinate
    this.pixel = init.pixel
    this.clientX = init.clientX
    this.clientY = init.clientY
    this.originalEvent = init.originalEvent
    this.timeStamp = init.originalEvent.timeStamp
  }

  get defaultPrevented(): boolean { return this._defaultPrevented }

  /** Stop further listeners on this layer from firing for this event.
   *  Phase 5 will extend this to stop fall-through to lower layers when
   *  bubbling lands. */
  preventDefault(): void { this._defaultPrevented = true }

  /** DOM-style alias for `preventDefault` — same effect today. */
  stopPropagation(): void { this._defaultPrevented = true }
}

export type XGISFeatureListener = (event: XGISFeatureEvent) => void

/** EventTarget-flavoured listener bookkeeping shared by `XGISLayer`
 *  (per-layer dispatch) and `XGISMap` (delegated dispatch — fires for
 *  any layer hit). Same `addEventListener` semantics: re-registering a
 *  listener is a no-op, `{ once }` self-removes after first fire,
 *  `{ signal }` removes on abort, dispatch iterates a snapshot so
 *  add/remove during dispatch is safe. */
export class ListenerRegistry {
  private map = new Map<XGISFeatureEventType, Map<XGISFeatureListener, XGISFeatureListener>>()

  add(
    type: XGISFeatureEventType,
    listener: XGISFeatureListener,
    options?: { signal?: AbortSignal; once?: boolean },
  ): void {
    if (options?.signal?.aborted) return
    let typeMap = this.map.get(type)
    if (!typeMap) { typeMap = new Map(); this.map.set(type, typeMap) }
    if (typeMap.has(listener)) return
    const wrapped: XGISFeatureListener = options?.once
      ? (e) => { typeMap!.delete(listener); listener(e) }
      : listener
    typeMap.set(listener, wrapped)
    options?.signal?.addEventListener('abort', () => typeMap!.delete(listener), { once: true })
  }

  remove(type: XGISFeatureEventType, listener: XGISFeatureListener): void {
    this.map.get(type)?.delete(listener)
  }

  has(type: XGISFeatureEventType): boolean {
    const typeMap = this.map.get(type)
    return !!typeMap && typeMap.size > 0
  }

  /** Fire every listener for `event.type`, in registration order, with
   *  early termination on `preventDefault`. Iterates a snapshot so
   *  add/remove inside a handler doesn't disturb the current dispatch.
   *  Listener exceptions are caught and logged (with `label` for source
   *  attribution) so one bad handler doesn't kill the rest. */
  dispatch(event: XGISFeatureEvent, label: string): void {
    const typeMap = this.map.get(event.type)
    if (!typeMap || typeMap.size === 0) return
    for (const wrapped of [...typeMap.values()]) {
      try { wrapped(event) }
      catch (e) { console.error(`[X-GIS] '${event.type}' listener on ${label}:`, e) }
      if (event.defaultPrevented) break
    }
  }
}

export class XGISLayer {
  readonly style: XGISLayerStyle
  private listeners = new ListenerRegistry()

  constructor(
    public readonly name: string,
    private show: ShowCommand,
    private invalidate: () => void,
  ) {
    this.style = new XGISLayerStyle({ show, invalidate })
  }

  /** Stable u16 ID for this layer (LayerIdRegistry-assigned). Useful for
   *  `pickAt` callers that want to match a hit's `layerId` to a layer
   *  without going through `getLayer(name)`. */
  get id(): number {
    return this.show.pickId ?? 0
  }

  addEventListener(
    type: XGISFeatureEventType,
    listener: XGISFeatureListener,
    options?: { signal?: AbortSignal; once?: boolean },
  ): void {
    this.listeners.add(type, listener, options)
  }

  removeEventListener(type: XGISFeatureEventType, listener: XGISFeatureListener): void {
    this.listeners.remove(type, listener)
  }

  /** Internal dispatcher reads this to know whether to spend a `pickAt`
   *  cycle for hover/click on this layer. */
  hasListeners(type: XGISFeatureEventType): boolean {
    return this.listeners.has(type)
  }

  /** Fire every listener registered for `event.type`. The event-dispatcher
   *  calls this — public for testability but not part of the documented
   *  surface. */
  dispatchEvent(event: XGISFeatureEvent): void {
    this.listeners.dispatch(event, `layer '${this.name}'`)
  }

  /** Convenience alias matching `XGISLayerStyle.reset` from the layer
   *  surface (mirrors how a DOM author might call `el.removeAttribute`
   *  on a single style prop). */
  resetStyle(key?: XGISLayerStyleKey): void {
    this.style.reset(key)
  }
}
