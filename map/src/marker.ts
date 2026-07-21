// ═══ Marker + Popup — DOM overlays anchored to geo coordinates (#1262) ═══
//
// MapLibre-parity `Marker` / `Popup`: an HTML element pinned to a `[lon, lat]`
// that tracks the camera. Built entirely on the map's PUBLIC surface — no
// render-pipeline coupling:
//   - map.project([lon,lat]) → canvas-local CSS px, or null when the point is
//     behind the globe limb / off the projection (the hide signal, free).
//   - map.unproject([x,y]) → [lon,lat] (drag).
//   - map.on('move', …) — reposition each frame the camera changes.
//   - map.getContainer() — the canvas parent the overlay elements live in.
//
// Positioning: the element's `transform` places its ANCHOR point on the
// projected pixel — `translate(x, y) translate(anchor%)` so a bottom-anchored
// pin's tip sits exactly on the coordinate. Popups additionally auto-FLIP their
// anchor near the viewport edge so they stay on-screen.
//
// The pure geometry (anchor→translate, edge flip) is exported for unit tests;
// the DOM wiring is exercised by the e2e/§5 gate (pixel-lock under pan/zoom,
// hidden behind the globe).

export type MarkerAnchor =
  | 'center'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

/** Minimal map surface Marker/Popup consume — satisfied structurally by
 *  XGISMap, so this module needs no import cycle back to map.ts. */
export interface MarkerMapLike {
  project(lonLat: readonly [number, number]): [number, number] | null
  unproject(screen: readonly [number, number]): [number, number] | null
  getContainer(): HTMLElement | null
  on(type: 'move', listener: () => void): void
  off(type: 'move', listener: () => void): void
}

/** CSS `translate(...)` percentage that shifts an element so its `anchor`
 *  point lands on the transform origin (the projected pixel). Pure. */
export function anchorTranslatePercent(anchor: MarkerAnchor): [number, number] {
  switch (anchor) {
    case 'center':
      return [-50, -50]
    case 'top':
      return [-50, 0]
    case 'bottom':
      return [-50, -100]
    case 'left':
      return [0, -50]
    case 'right':
      return [-100, -50]
    case 'top-left':
      return [0, 0]
    case 'top-right':
      return [-100, 0]
    case 'bottom-left':
      return [0, -100]
    case 'bottom-right':
      return [-100, -100]
  }
}

/** Compose the full transform string for an element whose `anchor` point sits
 *  at (x, y) canvas px, plus a px offset. `translate(px)` first (integer-
 *  snapped to avoid sub-pixel blur), then the anchor percentage. Pure. */
export function markerTransform(
  x: number,
  y: number,
  anchor: MarkerAnchor,
  offsetX: number,
  offsetY: number,
): string {
  const [px, py] = anchorTranslatePercent(anchor)
  const tx = Math.round(x + offsetX)
  const ty = Math.round(y + offsetY)
  return `translate(${tx}px, ${ty}px) translate(${px}%, ${py}%)`
}

/** Popup edge-flip: pick the anchor that keeps the popup on-screen given its
 *  anchor point (x, y) in a `vw`×`vh` viewport. Vertical band by thirds
 *  (top/·/bottom), horizontal band by thirds (left/·/right); the composite
 *  keeps the balloon growing INTO the viewport. Mirrors MapLibre's
 *  Popup#_updateClassList anchor pick. Pure. */
export function flipPopupAnchor(x: number, y: number, vw: number, vh: number): MarkerAnchor {
  let v = ''
  if (y < vh / 3) v = 'top'
  else if (y > (vh * 2) / 3) v = 'bottom'
  let h = ''
  if (x < vw / 3) h = 'left'
  else if (x > (vw * 2) / 3) h = 'right'
  if (v === '' && h === '') return 'bottom' // MapLibre default when centred
  if (v === '') return h as MarkerAnchor
  if (h === '') return v as MarkerAnchor
  return `${v}-${h}` as MarkerAnchor
}

const NS = 'http://www.w3.org/2000/svg'

/** Build the default teardrop pin (MapLibre-style), tinted `color`, wrapped in
 *  a div so `Marker.element` is always an `HTMLElement`. Bottom-anchored: the
 *  tip sits on the coordinate. */
function defaultPinElement(color: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.style.width = '27px'
  wrap.style.height = '41px'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', '27')
  svg.setAttribute('height', '41')
  svg.setAttribute('viewBox', '0 0 27 41')
  svg.style.display = 'block'
  const path = document.createElementNS(NS, 'path')
  // Teardrop: round head, tapering to a point at the bottom-centre (13.5, 41).
  path.setAttribute(
    'd',
    'M13.5 0C6.04 0 0 6.04 0 13.5C0 23 13.5 41 13.5 41S27 23 27 13.5C27 6.04 20.96 0 13.5 0Z',
  )
  path.setAttribute('fill', color)
  path.setAttribute('stroke', 'rgba(0,0,0,0.25)')
  path.setAttribute('stroke-width', '1')
  const dot = document.createElementNS(NS, 'circle')
  dot.setAttribute('cx', '13.5')
  dot.setAttribute('cy', '13.5')
  dot.setAttribute('r', '5.5')
  dot.setAttribute('fill', 'rgba(0,0,0,0.25)')
  svg.appendChild(path)
  svg.appendChild(dot)
  wrap.appendChild(svg)
  return wrap
}

export interface MarkerOptions {
  /** Custom DOM element. Absent → a default teardrop pin (see `color`). */
  element?: HTMLElement
  /** Which point of the element sits on the coordinate. Default: `center`
   *  for a custom element, `bottom` for the default pin (tip on the point). */
  anchor?: MarkerAnchor
  /** Extra px offset [dx, dy] applied after anchoring. Default [0, 0]. */
  offset?: [number, number]
  /** Default-pin fill colour. Default `#3b82f6`. Ignored with a custom element. */
  color?: string
  /** Enable pointer dragging (emits dragstart/drag/dragend). Default false. */
  draggable?: boolean
}

type MarkerEvent = 'dragstart' | 'drag' | 'dragend'

/** A geo-anchored DOM element that tracks the camera. */
export class Marker {
  private readonly element: HTMLElement
  private readonly anchor: MarkerAnchor
  private readonly offset: [number, number]
  private lngLat: [number, number] = [0, 0]
  private map: MarkerMapLike | null = null
  private popup: Popup | null = null
  private draggable: boolean
  private dragging = false
  private readonly listeners = new Map<MarkerEvent, Set<() => void>>()
  private readonly _onMove = (): void => this._update()
  private readonly _onPointerDown: (e: PointerEvent) => void
  private readonly _onPointerMove: (e: PointerEvent) => void
  private readonly _onPointerUp: (e: PointerEvent) => void

  constructor(options: MarkerOptions = {}) {
    const custom = options.element !== undefined
    this.element = options.element ?? defaultPinElement(options.color ?? '#3b82f6')
    this.anchor = options.anchor ?? (custom ? 'center' : 'bottom')
    this.offset = options.offset ?? [0, 0]
    this.draggable = options.draggable ?? false
    this.element.style.position = 'absolute'
    this.element.style.top = '0'
    this.element.style.left = '0'
    this.element.style.willChange = 'transform'
    this.element.style.userSelect = 'none'
    this.element.style.cursor = this.draggable ? 'grab' : 'pointer'
    // Drag handlers (attached only while draggable + added to a map).
    this._onPointerDown = (e) => {
      if (!this.draggable || this.map === null) return
      e.preventDefault()
      e.stopPropagation()
      this.dragging = true
      this.element.style.cursor = 'grabbing'
      this.element.setPointerCapture?.(e.pointerId)
      this._emit('dragstart')
    }
    this._onPointerMove = (e) => {
      if (!this.dragging || this.map === null) return
      const container = this.map.getContainer()
      if (container === null) return
      const rect = container.getBoundingClientRect()
      const ll = this.map.unproject([e.clientX - rect.left, e.clientY - rect.top])
      if (ll === null) return // pointer off the globe/surface — hold last position
      this.lngLat = [ll[0], ll[1]]
      this._update()
      this._emit('drag')
    }
    this._onPointerUp = (e) => {
      if (!this.dragging) return
      this.dragging = false
      this.element.style.cursor = 'grab'
      this.element.releasePointerCapture?.(e.pointerId)
      this._emit('dragend')
    }
  }

  setLngLat(lonLat: [number, number]): this {
    this.lngLat = [lonLat[0], lonLat[1]]
    this._update()
    this.popup?.setLngLat(this.lngLat)
    return this
  }
  getLngLat(): [number, number] {
    return [this.lngLat[0], this.lngLat[1]]
  }
  getElement(): HTMLElement {
    return this.element
  }

  addTo(map: MarkerMapLike): this {
    this.map = map
    const container = map.getContainer()
    if (container !== null) {
      ensurePositioned(container)
      container.appendChild(this.element)
    }
    map.on('move', this._onMove)
    this.element.addEventListener('pointerdown', this._onPointerDown)
    // Toggle the paired popup on click (unless a drag just happened).
    this.element.addEventListener('click', this._onClick)
    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', this._onPointerMove)
      window.addEventListener('pointerup', this._onPointerUp)
    }
    this._update()
    return this
  }

  remove(): this {
    if (this.map !== null) {
      this.map.off('move', this._onMove)
      this.map = null
    }
    this.element.removeEventListener('pointerdown', this._onPointerDown)
    this.element.removeEventListener('click', this._onClick)
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', this._onPointerMove)
      window.removeEventListener('pointerup', this._onPointerUp)
    }
    this.element.parentNode?.removeChild(this.element)
    this.popup?.remove()
    return this
  }

  setDraggable(v: boolean): this {
    this.draggable = v
    this.element.style.cursor = v ? 'grab' : 'pointer'
    return this
  }
  isDraggable(): boolean {
    return this.draggable
  }

  /** Attach a popup; a click on the marker toggles it (MapLibre parity). */
  setPopup(popup: Popup | null): this {
    this.popup?.remove()
    this.popup = popup
    popup?.setLngLat(this.lngLat)
    return this
  }
  getPopup(): Popup | null {
    return this.popup
  }
  togglePopup(): this {
    if (this.popup === null || this.map === null) return this
    if (this.popup.isOpen()) this.popup.remove()
    else this.popup.addTo(this.map)
    return this
  }
  private readonly _onClick = (e: MouseEvent): void => {
    e.stopPropagation()
    this.togglePopup()
  }

  on(type: MarkerEvent, listener: () => void): this {
    let s = this.listeners.get(type)
    if (s === undefined) {
      s = new Set()
      this.listeners.set(type, s)
    }
    s.add(listener)
    return this
  }
  off(type: MarkerEvent, listener: () => void): this {
    this.listeners.get(type)?.delete(listener)
    return this
  }
  private _emit(type: MarkerEvent): void {
    const s = this.listeners.get(type)
    if (s !== undefined) for (const l of s) l()
  }

  /** Reproject + reposition (or hide behind the globe). */
  private _update(): void {
    if (this.map === null) return
    const p = this.map.project(this.lngLat)
    if (p === null) {
      this.element.style.display = 'none'
      return
    }
    this.element.style.display = ''
    this.element.style.transform = markerTransform(
      p[0],
      p[1],
      this.anchor,
      this.offset[0],
      this.offset[1],
    )
  }
}

export interface PopupOptions {
  /** Anchor point of the popup relative to its coordinate. Absent → the
   *  anchor auto-flips each frame to keep the balloon on-screen. */
  anchor?: MarkerAnchor
  /** Extra px offset [dx, dy] after anchoring. Default [0, 0]. */
  offset?: [number, number]
  /** Render an `×` close button (default true). */
  closeButton?: boolean
  /** Close when the user clicks the map (default true). */
  closeOnClick?: boolean
  /** Extra class on the popup root. */
  className?: string
  /** Max width CSS value for the content (default `240px`). */
  maxWidth?: string
}

/** A geo-anchored info balloon. Auto-flips its anchor near viewport edges. */
export class Popup {
  private readonly root: HTMLElement
  private readonly content: HTMLElement
  private readonly fixedAnchor: MarkerAnchor | null
  private readonly offset: [number, number]
  private readonly closeOnClick: boolean
  private lngLat: [number, number] = [0, 0]
  private map: MarkerMapLike | null = null
  private readonly _onMove = (): void => this._update()
  private readonly _onMapClick = (): void => {
    if (this.closeOnClick) this.remove()
  }

  constructor(options: PopupOptions = {}) {
    this.fixedAnchor = options.anchor ?? null
    this.offset = options.offset ?? [0, 0]
    this.closeOnClick = options.closeOnClick ?? true
    this.root = document.createElement('div')
    this.root.className = 'xgis-popup' + (options.className ? ' ' + options.className : '')
    this.root.style.position = 'absolute'
    this.root.style.top = '0'
    this.root.style.left = '0'
    this.root.style.willChange = 'transform'
    this.root.style.maxWidth = options.maxWidth ?? '240px'
    this.root.style.background = '#fff'
    this.root.style.color = '#111'
    this.root.style.padding = '10px 12px'
    this.root.style.borderRadius = '6px'
    this.root.style.boxShadow = '0 1px 4px rgba(0,0,0,0.3)'
    this.root.style.font = '13px system-ui, sans-serif'
    this.root.style.pointerEvents = 'auto'
    // A click INSIDE the popup must not trigger closeOnClick (the container
    // listener below); stop it at the root.
    this.root.addEventListener('click', (e) => e.stopPropagation())
    this.content = document.createElement('div')
    this.root.appendChild(this.content)
    if (options.closeButton ?? true) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = '×'
      btn.setAttribute('aria-label', 'Close popup')
      btn.style.cssText =
        'position:absolute;top:2px;right:6px;border:0;background:transparent;font-size:16px;line-height:1;cursor:pointer;color:#666'
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.remove()
      })
      this.root.appendChild(btn)
    }
  }

  setLngLat(lonLat: [number, number]): this {
    this.lngLat = [lonLat[0], lonLat[1]]
    this._update()
    return this
  }
  getLngLat(): [number, number] {
    return [this.lngLat[0], this.lngLat[1]]
  }
  setText(text: string): this {
    this.content.textContent = text
    return this
  }
  setHTML(html: string): this {
    this.content.innerHTML = html
    return this
  }
  setDOMContent(node: Node): this {
    this.content.innerHTML = ''
    this.content.appendChild(node)
    return this
  }
  getElement(): HTMLElement {
    return this.root
  }
  isOpen(): boolean {
    return this.map !== null
  }

  addTo(map: MarkerMapLike): this {
    this.map = map
    const container = map.getContainer()
    if (container !== null) {
      ensurePositioned(container)
      container.appendChild(this.root)
      // closeOnClick — a click on the map surface (not the popup, which stops
      // propagation at its root) dismisses the balloon (MapLibre parity).
      if (this.closeOnClick) container.addEventListener('click', this._onMapClick)
    }
    map.on('move', this._onMove)
    this._update()
    return this
  }

  remove(): this {
    if (this.map !== null) {
      this.map.getContainer()?.removeEventListener('click', this._onMapClick)
      this.map.off('move', this._onMove)
      this.map = null
    }
    this.root.parentNode?.removeChild(this.root)
    return this
  }

  private _update(): void {
    if (this.map === null) return
    const p = this.map.project(this.lngLat)
    if (p === null) {
      this.root.style.display = 'none'
      return
    }
    this.root.style.display = ''
    let anchor = this.fixedAnchor
    if (anchor === null) {
      const container = this.map.getContainer()
      const vw = container?.clientWidth ?? 0
      const vh = container?.clientHeight ?? 0
      anchor = flipPopupAnchor(p[0], p[1], vw, vh)
    }
    this.root.style.transform = markerTransform(p[0], p[1], anchor, this.offset[0], this.offset[1])
  }
}

/** The overlay elements are absolutely positioned; their offset parent must be
 *  positioned or they anchor to the viewport. Mirror MapLibre: promote a
 *  `static` container to `relative` (leave an already-positioned one alone). */
function ensurePositioned(el: HTMLElement): void {
  if (typeof window === 'undefined') return
  const pos = window.getComputedStyle(el).position
  if (pos === 'static' || pos === '') el.style.position = 'relative'
}
