// Vanilla DOM + SVG node editor — Unreal-Blueprint grade. No deps
// (matches the site's zero-runtime convention).
//
// Geometry: a `world` <div> (CSS transform translate+scale) holds
// absolutely-positioned node cards + comment frames; an <svg><g>
// with the same transform holds the wires. Wire endpoints are read
// back from live pin DOM rects (screen→world) so cards of any height
// stay connected without a hand-maintained layout.
//
// Capabilities: history (undo/redo), marquee + multi-select, group
// move/duplicate/copy-paste, comment frames (move/resize/collapse),
// reroute knots, drag-from-pin contextual search-create, search
// palette, on-node diagnostics, minimap, zoom-to-fit/selection,
// snap-to-grid, align/distribute, inspector panel, pin
// highlight/dim, tooltips, node LOD, source data peek.

import {
  NODE_SPECS,
  PIN_COLOR,
  defaultData,
  pinCompatible,
  uid,
  type BPEdge,
  type BPFrame,
  type BPGraph,
  type BPNode,
  type FieldSpec,
  type NodeType,
  type PinSpec,
  type PinType,
} from './types'
import { bezier } from './geometry'
import { History } from './history'
import { computeNodeIssues } from './diagnostics'
import { renderMinimap } from './minimap'
import { openSearchPalette } from './palette'
import { peekData } from './datapeek'

interface Opts {
  viewport: HTMLElement
  inspector: HTMLElement
  onChange: () => void
}

const SVGNS = 'http://www.w3.org/2000/svg'
const GRID = 20
const FRAME_COLORS = ['#2997ff', '#34d399', '#f5a623', '#f472b6', '#a78bfa', '#8a8f98']

type Drag =
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | { kind: 'node'; id: string; ox: Map<string, [number, number]>; mx: number; my: number }
  | { kind: 'frame'; id: string; ox: Map<string, [number, number]>; fx: number; fy: number; mx: number; my: number }
  | { kind: 'resize'; id: string; mx: number; my: number; w: number; h: number }
  | { kind: 'wire'; from: { node: string; pin: string; ptype: PinType } }
  | { kind: 'marquee'; x0: number; y0: number }
  | null

export class BlueprintEditor {
  private vp: HTMLElement
  private inspectorEl: HTMLElement
  private world!: HTMLElement
  private svg!: SVGSVGElement
  private gEdges!: SVGGElement
  private tempPath!: SVGPathElement
  private marqueeEl!: HTMLElement
  private mini!: HTMLElement
  private palette!: HTMLElement
  private onChange: () => void

  private nodes: BPNode[] = []
  private edges: BPEdge[] = []
  private frames: BPFrame[] = []
  private pan = { x: 40, y: 40 }
  private zoom = 1
  private zTop = 1
  private snap = false

  private nodeEls = new Map<string, HTMLElement>()
  private pinEls = new Map<string, HTMLElement>()
  private edgeEls = new Map<string, { hit: SVGPathElement; vis: SVGPathElement }>()
  private frameEls = new Map<string, HTMLElement>()
  private selNodes = new Set<string>()
  private selFrames = new Set<string>()
  private selEdge: string | null = null

  private drag: Drag = null
  private ctxWorld = { x: 0, y: 0 }
  private rafPending = false
  private history = new History()
  private fieldDirty = false

  constructor(o: Opts) {
    this.vp = o.viewport
    this.inspectorEl = o.inspector
    this.onChange = o.onChange
    this.build()
    this.wire()
  }

  // ── public API ──
  load(g: BPGraph) {
    this.nodes = g.nodes.map((n) => ({ ...n, data: { ...n.data } }))
    this.edges = g.edges.map((e) => ({ ...e }))
    this.frames = (g.frames ?? []).map((f) => ({ ...f }))
    this.selNodes.clear()
    this.selFrames.clear()
    this.selEdge = null
    this.renderAll()
    this.emit()
  }
  getGraph(): BPGraph {
    return {
      nodes: this.nodes.map((n) => ({ ...n, data: { ...n.data } })),
      edges: this.edges.map((e) => ({ ...e })),
      frames: this.frames.map((f) => ({ ...f })),
    }
  }
  clear() {
    this.record()
    this.nodes = []
    this.edges = []
    this.frames = []
    this.selNodes.clear()
    this.selFrames.clear()
    this.selEdge = null
    this.renderAll()
    this.emit()
  }
  resetView() {
    this.pan = { x: 40, y: 40 }
    this.zoom = 1
    this.applyTransform()
    this.scheduleRedraw()
  }
  setSnap(on: boolean) {
    this.snap = on
  }
  addNode(type: NodeType, wx?: number, wy?: number): string | null {
    if (NODE_SPECS[type].singleton && this.nodes.some((n) => n.type === type)) return null
    this.record()
    const n: BPNode = {
      id: uid('n'),
      type,
      x: wx ?? -this.pan.x / this.zoom + 80,
      y: wy ?? -this.pan.y / this.zoom + 80,
      data: defaultData(type),
    }
    this.nodes.push(n)
    this.mountNode(n)
    this.scheduleRedraw()
    this.emit()
    return n.id
  }

  addFrame() {
    this.record()
    let x: number
    let y: number
    let w = 360
    let h = 240
    const sel = [...this.selNodes].map((id) => this.nodes.find((n) => n.id === id)).filter(Boolean) as BPNode[]
    if (sel.length) {
      const xs = sel.map((n) => n.x)
      const ys = sel.map((n) => n.y)
      x = Math.min(...xs) - 30
      y = Math.min(...ys) - 56
      w = Math.max(...xs) - x + 270
      h = Math.max(...ys) - y + 200
    } else {
      x = -this.pan.x / this.zoom + 60
      y = -this.pan.y / this.zoom + 60
    }
    const f: BPFrame = { id: uid('f'), x, y, w, h, title: 'Comment', color: FRAME_COLORS[this.frames.length % FRAME_COLORS.length] }
    this.frames.push(f)
    this.mountFrame(f)
    this.scheduleRedraw()
    this.emit()
  }

  undo() {
    const s = this.history.undo(this.snapshot())
    if (s !== null) this.restore(s)
  }
  redo() {
    const s = this.history.redo(this.snapshot())
    if (s !== null) this.restore(s)
  }

  fit(selectionOnly = false) {
    const ns = selectionOnly && this.selNodes.size ? this.nodes.filter((n) => this.selNodes.has(n.id)) : this.nodes
    if (!ns.length) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of ns) {
      const el = this.nodeEls.get(n.id)
      const w = el?.offsetWidth ?? 232
      const h = el?.offsetHeight ?? 120
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + w)
      maxY = Math.max(maxY, n.y + h)
    }
    const r = this.vp.getBoundingClientRect()
    const pad = 60
    const z = Math.min(2, Math.max(0.2, Math.min(r.width / (maxX - minX + pad * 2), r.height / (maxY - minY + pad * 2))))
    this.zoom = z
    this.pan.x = r.width / 2 - ((minX + maxX) / 2) * z
    this.pan.y = r.height / 2 - ((minY + maxY) / 2) * z
    this.applyTransform()
    this.scheduleRedraw()
  }

  align(mode: 'left' | 'top' | 'hdist' | 'vdist') {
    const sel = [...this.selNodes].map((id) => this.nodes.find((n) => n.id === id)).filter(Boolean) as BPNode[]
    if (sel.length < 2) return
    this.record()
    if (mode === 'left') {
      const x = Math.min(...sel.map((n) => n.x))
      sel.forEach((n) => (n.x = x))
    } else if (mode === 'top') {
      const y = Math.min(...sel.map((n) => n.y))
      sel.forEach((n) => (n.y = y))
    } else if (mode === 'hdist') {
      sel.sort((a, b) => a.x - b.x)
      const span = sel[sel.length - 1].x - sel[0].x
      const step = span / (sel.length - 1)
      sel.forEach((n, i) => (n.x = sel[0].x + step * i))
    } else {
      sel.sort((a, b) => a.y - b.y)
      const span = sel[sel.length - 1].y - sel[0].y
      const step = span / (sel.length - 1)
      sel.forEach((n, i) => (n.y = sel[0].y + step * i))
    }
    sel.forEach((n) => this.placeNode(n))
    this.scheduleRedraw()
    this.emit()
  }

  // ── history ──
  private snapshot(): string {
    return JSON.stringify({ nodes: this.nodes, edges: this.edges, frames: this.frames })
  }
  private record() {
    this.history.record(this.snapshot())
  }
  private restore(s: string) {
    const g = JSON.parse(s)
    this.nodes = g.nodes
    this.edges = g.edges
    this.frames = g.frames ?? []
    this.selNodes.clear()
    this.selFrames.clear()
    this.selEdge = null
    this.renderAll()
    this.emit()
  }

  // ── scaffold ──
  private build() {
    this.vp.classList.add('bp-vp')
    this.svg = document.createElementNS(SVGNS, 'svg')
    this.svg.classList.add('bp-svg')
    this.gEdges = document.createElementNS(SVGNS, 'g')
    this.svg.appendChild(this.gEdges)
    this.tempPath = document.createElementNS(SVGNS, 'path')
    this.tempPath.classList.add('bp-wire', 'bp-wire-temp')
    this.tempPath.style.display = 'none'
    this.gEdges.appendChild(this.tempPath)

    this.world = document.createElement('div')
    this.world.className = 'bp-world'

    this.marqueeEl = document.createElement('div')
    this.marqueeEl.className = 'bp-marquee'
    this.marqueeEl.style.display = 'none'

    this.palette = document.createElement('div')
    this.palette.className = 'bp-ctx'
    this.palette.style.display = 'none'

    this.mini = document.createElement('div')
    this.mini.className = 'bp-mini'

    this.vp.append(this.svg, this.world, this.marqueeEl, this.mini, this.palette)
    this.resizeSvg()
    this.applyTransform()
  }

  private wire() {
    this.vp.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return
      const t = e.target as HTMLElement
      const empty = t === this.vp || t === this.world || t === (this.svg as unknown as HTMLElement)
      if (!empty) return
      if (e.shiftKey) {
        const w = this.toWorld(e.clientX, e.clientY)
        this.drag = { kind: 'marquee', x0: w.x, y0: w.y }
      } else {
        this.selectNone()
        this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: this.pan.x, py: this.pan.y }
        document.body.classList.add('bp-grabbing')
      }
    })
    window.addEventListener('pointermove', (e) => this.onMove(e))
    window.addEventListener('pointerup', (e) => this.onUp(e))

    this.vp.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const r = this.vp.getBoundingClientRect()
        const cx = e.clientX - r.left
        const cy = e.clientY - r.top
        const z = Math.min(2.4, Math.max(0.2, this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
        this.pan.x = cx - ((cx - this.pan.x) * z) / this.zoom
        this.pan.y = cy - ((cy - this.pan.y) * z) / this.zoom
        this.zoom = z
        this.applyTransform()
        this.scheduleRedraw()
      },
      { passive: false },
    )

    this.vp.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.openPalette(e.clientX, e.clientY)
    })
    this.vp.addEventListener('pointerdown', (e) => {
      if (!this.palette.contains(e.target as Node)) this.palette.style.display = 'none'
    })

    window.addEventListener('keydown', (e) => {
      const ae = document.activeElement as HTMLElement | null
      const typing = ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)
      if (typing) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? this.redo() : this.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        this.redo()
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        this.duplicateSelection()
      } else if (mod && e.key.toLowerCase() === 'c') {
        this.copySelection()
      } else if (mod && e.key.toLowerCase() === 'v') {
        void this.pasteClipboard()
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        this.selectAll()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        this.deleteSelection()
      } else if (e.key === 'Escape') {
        this.cancelWire()
        this.palette.style.display = 'none'
      } else if (e.key === 'f' || e.key === 'F') {
        this.fit(this.selNodes.size > 0)
      } else if (e.key === 'a' || e.key === 'A') {
        const r = this.vp.getBoundingClientRect()
        this.openPalette(r.left + r.width / 2, r.top + r.height / 2)
      }
    })
    window.addEventListener('resize', () => {
      this.resizeSvg()
      this.scheduleRedraw()
    })
  }

  private resizeSvg() {
    const r = this.vp.getBoundingClientRect()
    this.svg.setAttribute('width', String(r.width))
    this.svg.setAttribute('height', String(r.height))
  }
  private applyTransform() {
    this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`
    this.gEdges.setAttribute('transform', `translate(${this.pan.x},${this.pan.y}) scale(${this.zoom})`)
    this.world.classList.toggle('bp-lod', this.zoom < 0.5)
    this.drawMini()
  }
  private toWorld(clientX: number, clientY: number) {
    const r = this.vp.getBoundingClientRect()
    return { x: (clientX - r.left - this.pan.x) / this.zoom, y: (clientY - r.top - this.pan.y) / this.zoom }
  }

  // ── render ──
  private renderAll() {
    this.nodeEls.forEach((el) => el.remove())
    this.frameEls.forEach((el) => el.remove())
    this.nodeEls.clear()
    this.frameEls.clear()
    this.pinEls.clear()
    this.edgeEls.forEach(({ hit, vis }) => {
      hit.remove()
      vis.remove()
    })
    this.edgeEls.clear()
    for (const f of this.frames) this.mountFrame(f)
    for (const n of this.nodes) this.mountNode(n)
    this.scheduleRedraw()
    this.renderInspector()
  }

  private placeNode(n: BPNode) {
    const el = this.nodeEls.get(n.id)
    if (el) {
      el.style.left = `${n.x}px`
      el.style.top = `${n.y}px`
    }
  }

  private mountFrame(f: BPFrame) {
    const el = document.createElement('div')
    el.className = 'bp-frame'
    el.style.left = `${f.x}px`
    el.style.top = `${f.y}px`
    el.style.width = `${f.w}px`
    el.style.height = f.collapsed ? '34px' : `${f.h}px`
    el.style.setProperty('--fc', f.color)
    el.dataset.id = f.id

    const bar = document.createElement('div')
    bar.className = 'bp-frame-bar'
    const tog = document.createElement('button')
    tog.type = 'button'
    tog.className = 'bp-frame-tog'
    tog.textContent = f.collapsed ? '▸' : '▾'
    tog.title = 'Collapse / expand'
    tog.addEventListener('pointerdown', (e) => e.stopPropagation())
    tog.addEventListener('click', (e) => {
      e.stopPropagation()
      this.record()
      f.collapsed = !f.collapsed
      this.renderAll()
      this.emit()
    })
    const title = document.createElement('input')
    title.className = 'bp-frame-title'
    title.value = f.title
    title.addEventListener('pointerdown', (e) => e.stopPropagation())
    title.addEventListener('focus', () => this.recordFieldOnce())
    title.addEventListener('input', () => {
      f.title = title.value
      this.emit()
    })
    const sw = document.createElement('button')
    sw.type = 'button'
    sw.className = 'bp-frame-sw'
    sw.title = 'Cycle colour'
    sw.addEventListener('pointerdown', (e) => e.stopPropagation())
    sw.addEventListener('click', (e) => {
      e.stopPropagation()
      this.record()
      f.color = FRAME_COLORS[(FRAME_COLORS.indexOf(f.color) + 1) % FRAME_COLORS.length]
      el.style.setProperty('--fc', f.color)
      this.emit()
    })
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'bp-frame-del'
    del.textContent = '×'
    del.title = 'Delete frame (keeps nodes)'
    del.addEventListener('pointerdown', (e) => e.stopPropagation())
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      this.record()
      this.frames = this.frames.filter((x) => x.id !== f.id)
      el.remove()
      this.frameEls.delete(f.id)
      this.emit()
    })
    bar.append(tog, title, sw, del)
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      this.record()
      const inside = new Map<string, [number, number]>()
      for (const n of this.nodes) if (this.nodeInFrame(n, f)) inside.set(n.id, [n.x, n.y])
      this.drag = { kind: 'frame', id: f.id, ox: inside, fx: f.x, fy: f.y, mx: e.clientX, my: e.clientY }
      document.body.classList.add('bp-grabbing')
    })
    el.appendChild(bar)

    if (!f.collapsed) {
      const grip = document.createElement('div')
      grip.className = 'bp-frame-grip'
      grip.addEventListener('pointerdown', (e) => {
        e.stopPropagation()
        this.record()
        this.drag = { kind: 'resize', id: f.id, mx: e.clientX, my: e.clientY, w: f.w, h: f.h }
        document.body.classList.add('bp-grabbing')
      })
      el.appendChild(grip)
    }
    this.world.appendChild(el)
    this.frameEls.set(f.id, el)
  }

  private nodeInFrame(n: BPNode, f: BPFrame): boolean {
    const el = this.nodeEls.get(n.id)
    const w = el?.offsetWidth ?? 232
    const h = el?.offsetHeight ?? 120
    const cx = n.x + w / 2
    const cy = n.y + h / 2
    return cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h
  }

  private mountNode(n: BPNode) {
    const spec = NODE_SPECS[n.type]
    const card = document.createElement('div')
    card.className = n.type === 'reroute' ? 'bp-node bp-reroute' : 'bp-node'
    card.style.left = `${n.x}px`
    card.style.top = `${n.y}px`
    card.style.zIndex = String((this.zTop += 1))
    card.dataset.id = n.id
    if (this.selNodes.has(n.id)) card.classList.add('bp-selected')

    if (n.type === 'reroute') {
      const inP = this.mountPort(n, spec.inputs[0], 'in')
      const outP = this.mountPort(n, spec.outputs[0], 'out')
      inP.classList.add('bp-rr-in')
      outP.classList.add('bp-rr-out')
      card.append(inP, outP)
      card.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        if ((e.target as HTMLElement).classList.contains('bp-pin')) return
        e.stopPropagation()
        this.beginNodeDrag(n, e, card)
      })
      this.world.appendChild(card)
      this.nodeEls.set(n.id, card)
      return
    }

    const head = document.createElement('div')
    head.className = 'bp-head'
    head.style.setProperty('--accent', spec.accent)
    head.title = spec.blurb
    head.innerHTML = `<span class="bp-dot"></span><span class="bp-title">${spec.title}</span>`
    const badge = document.createElement('span')
    badge.className = 'bp-badge'
    badge.style.display = 'none'
    head.appendChild(badge)
    const del = document.createElement('button')
    del.className = 'bp-del'
    del.type = 'button'
    del.title = 'Delete node'
    del.textContent = '×'
    del.addEventListener('pointerdown', (e) => e.stopPropagation())
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      this.record()
      this.removeNode(n.id)
      this.emit()
    })
    head.appendChild(del)
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      this.beginNodeDrag(n, e, card)
    })
    card.appendChild(head)

    if (spec.inputs.length || spec.outputs.length) {
      const ports = document.createElement('div')
      ports.className = 'bp-ports'
      const colIn = document.createElement('div')
      colIn.className = 'bp-col'
      const colOut = document.createElement('div')
      colOut.className = 'bp-col bp-col-out'
      for (const p of spec.inputs) colIn.appendChild(this.mountPort(n, p, 'in'))
      for (const p of spec.outputs) colOut.appendChild(this.mountPort(n, p, 'out'))
      ports.append(colIn, colOut)
      card.appendChild(ports)
    }

    if (n.type === 'map') {
      const order = document.createElement('div')
      order.className = 'bp-order'
      card.appendChild(order)
    }

    if (spec.fields.length) {
      const fields = document.createElement('div')
      fields.className = 'bp-fields'
      for (const f of spec.fields) fields.appendChild(this.mountField(n, f))
      card.appendChild(fields)
    }

    this.world.appendChild(card)
    this.nodeEls.set(n.id, card)
  }

  private mountField(n: BPNode, f: FieldSpec): HTMLElement {
    const wrap = document.createElement('label')
    wrap.className = 'bp-field'
    const lab = document.createElement('span')
    lab.className = 'bp-flabel'
    lab.textContent = f.label
    wrap.appendChild(lab)
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    if (f.kind === 'select') {
      input = document.createElement('select')
      for (const opt of f.options ?? []) {
        const o = document.createElement('option')
        o.value = opt
        o.textContent = opt
        input.appendChild(o)
      }
      input.value = n.data[f.key] ?? ''
    } else if (f.kind === 'textarea') {
      input = document.createElement('textarea')
      input.rows = 2
      input.value = n.data[f.key] ?? ''
      if (f.placeholder) input.placeholder = f.placeholder
    } else {
      input = document.createElement('input')
      input.type = 'text'
      input.value = n.data[f.key] ?? ''
      if (f.placeholder) input.placeholder = f.placeholder
    }
    input.className = 'bp-input'
    input.dataset.k = f.key
    input.addEventListener('pointerdown', (e) => e.stopPropagation())
    input.addEventListener('focus', () => this.recordFieldOnce())
    const handler = () => {
      n.data[f.key] = input.value
      if (f.kind === 'textarea') this.scheduleRedraw()
      this.syncInspector(n)
      this.emit()
    }
    input.addEventListener('input', handler)
    input.addEventListener('change', handler)
    wrap.appendChild(input)
    return wrap
  }

  private mountPort(n: BPNode, p: PinSpec, dir: 'in' | 'out'): HTMLElement {
    const row = document.createElement('div')
    row.className = `bp-port bp-port-${dir}`
    const pin = document.createElement('span')
    pin.className = 'bp-pin'
    pin.style.background = PIN_COLOR[p.type]
    pin.dataset.node = n.id
    pin.dataset.pin = p.id
    pin.dataset.dir = dir
    pin.dataset.ptype = p.type
    pin.title = `${p.label || p.id} : ${p.type}`
    const lab = document.createElement('span')
    lab.className = 'bp-plabel'
    lab.textContent = p.label + (p.required ? ' *' : '')
    if (dir === 'in') row.append(pin, lab)
    else row.append(lab, pin)
    pin.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      e.preventDefault()
      this.startWire(n.id, p, dir)
    })
    this.pinEls.set(`${n.id}:${p.id}`, pin)
    return row
  }

  private beginNodeDrag(n: BPNode, e: PointerEvent, card: HTMLElement) {
    if (!this.selNodes.has(n.id)) {
      if (!e.shiftKey) this.selectNone()
      this.selNodes.add(n.id)
    } else if (e.shiftKey) {
      this.selNodes.delete(n.id)
    }
    this.refreshSelection()
    this.renderInspector()
    card.style.zIndex = String((this.zTop += 1))
    this.record()
    const ox = new Map<string, [number, number]>()
    for (const id of this.selNodes) {
      const nn = this.nodes.find((x) => x.id === id)
      if (nn) ox.set(id, [nn.x, nn.y])
    }
    if (!ox.has(n.id)) ox.set(n.id, [n.x, n.y])
    this.drag = { kind: 'node', id: n.id, ox, mx: e.clientX, my: e.clientY }
    document.body.classList.add('bp-grabbing')
  }

  // ── interaction ──
  private onMove(e: PointerEvent) {
    const d = this.drag
    if (!d) return
    if (d.kind === 'pan') {
      this.pan.x = d.px + (e.clientX - d.sx)
      this.pan.y = d.py + (e.clientY - d.sy)
      this.applyTransform()
      this.scheduleRedraw()
    } else if (d.kind === 'node') {
      const dx = (e.clientX - d.mx) / this.zoom
      const dy = (e.clientY - d.my) / this.zoom
      for (const [id, [ox, oy]] of d.ox) {
        const nn = this.nodes.find((x) => x.id === id)
        if (!nn) continue
        nn.x = ox + dx
        nn.y = oy + dy
        this.placeNode(nn)
      }
      this.scheduleRedraw()
    } else if (d.kind === 'frame') {
      const dx = (e.clientX - d.mx) / this.zoom
      const dy = (e.clientY - d.my) / this.zoom
      const f = this.frames.find((x) => x.id === d.id)!
      f.x = d.fx + dx
      f.y = d.fy + dy
      const el = this.frameEls.get(f.id)!
      el.style.left = `${f.x}px`
      el.style.top = `${f.y}px`
      for (const [id, [ox, oy]] of d.ox) {
        const nn = this.nodes.find((x) => x.id === id)
        if (!nn) continue
        nn.x = ox + dx
        nn.y = oy + dy
        this.placeNode(nn)
      }
      this.scheduleRedraw()
    } else if (d.kind === 'resize') {
      const f = this.frames.find((x) => x.id === d.id)!
      f.w = Math.max(160, d.w + (e.clientX - d.mx) / this.zoom)
      f.h = Math.max(90, d.h + (e.clientY - d.my) / this.zoom)
      const el = this.frameEls.get(f.id)!
      el.style.width = `${f.w}px`
      el.style.height = `${f.h}px`
    } else if (d.kind === 'wire') {
      const w = this.toWorld(e.clientX, e.clientY)
      const a = this.pinCenter(d.from.node, d.from.pin)
      if (a) {
        this.tempPath.style.display = ''
        this.tempPath.setAttribute('stroke', PIN_COLOR[d.from.ptype])
        this.tempPath.setAttribute('d', bezier(a.x, a.y, w.x, w.y))
      }
    } else if (d.kind === 'marquee') {
      const w = this.toWorld(e.clientX, e.clientY)
      const x = Math.min(d.x0, w.x)
      const y = Math.min(d.y0, w.y)
      const ww = Math.abs(w.x - d.x0)
      const hh = Math.abs(w.y - d.y0)
      this.marqueeEl.style.display = ''
      this.marqueeEl.style.left = `${this.pan.x + x * this.zoom}px`
      this.marqueeEl.style.top = `${this.pan.y + y * this.zoom}px`
      this.marqueeEl.style.width = `${ww * this.zoom}px`
      this.marqueeEl.style.height = `${hh * this.zoom}px`
    }
  }

  private onUp(e: PointerEvent) {
    const d = this.drag
    this.drag = null
    document.body.classList.remove('bp-grabbing')
    if (!d) return
    if (d.kind === 'node') {
      if (this.snap)
        for (const id of d.ox.keys()) {
          const nn = this.nodes.find((x) => x.id === id)
          if (nn) {
            nn.x = Math.round(nn.x / GRID) * GRID
            nn.y = Math.round(nn.y / GRID) * GRID
            this.placeNode(nn)
          }
        }
      this.scheduleRedraw()
      this.emit()
    } else if (d.kind === 'frame' || d.kind === 'resize') {
      this.scheduleRedraw()
      this.emit()
    } else if (d.kind === 'wire') {
      this.tempPath.style.display = 'none'
      this.clearPinHints()
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      if (el && el.classList.contains('bp-pin')) {
        this.tryConnect(d.from, {
          node: el.dataset.node!,
          pin: el.dataset.pin!,
          dir: el.dataset.dir as 'in' | 'out',
          ptype: el.dataset.ptype as PinType,
        })
      } else {
        // dropped on empty canvas → contextual create + auto-wire
        this.openPalette(e.clientX, e.clientY, d.from)
      }
    } else if (d.kind === 'marquee') {
      this.marqueeEl.style.display = 'none'
      const m = this.marqueeEl
      const left = parseFloat(m.style.left)
      const top = parseFloat(m.style.top)
      const w = parseFloat(m.style.width)
      const h = parseFloat(m.style.height)
      if (w > 4 && h > 4) {
        const vp = this.vp.getBoundingClientRect()
        for (const n of this.nodes) {
          const el = this.nodeEls.get(n.id)
          if (!el) continue
          const r = el.getBoundingClientRect()
          const rx = r.left - vp.left
          const ry = r.top - vp.top
          if (rx + r.width > left && rx < left + w && ry + r.height > top && ry < top + h)
            this.selNodes.add(n.id)
        }
        this.refreshSelection()
        this.renderInspector()
      }
    }
  }

  private startWire(nodeId: string, p: PinSpec, dir: 'in' | 'out') {
    if (dir === 'in') {
      const ex = this.edges.find((x) => x.to.node === nodeId && x.to.pin === p.id)
      if (ex) {
        this.record()
        const fromNode = ex.from.node
        const fromPin = ex.from.pin
        const ft = this.pinType(fromNode, fromPin) ?? p.type
        this.edges = this.edges.filter((x) => x.id !== ex.id)
        this.renderEdges()
        this.emit()
        this.drag = { kind: 'wire', from: { node: fromNode, pin: fromPin, ptype: ft } }
        this.showPinHints('out', ft)
        return
      }
    }
    this.drag = { kind: 'wire', from: { node: nodeId, pin: p.id, ptype: p.type } }
    this.showPinHints(dir === 'out' ? 'in' : 'out', p.type)
  }
  private cancelWire() {
    if (this.drag?.kind === 'wire') {
      this.tempPath.style.display = 'none'
      this.clearPinHints()
      this.drag = null
    }
  }
  private showPinHints(wantDir: 'in' | 'out', t: PinType) {
    this.pinEls.forEach((el) => {
      const ok = el.dataset.dir === wantDir && pinCompatible(el.dataset.ptype as PinType, t)
      el.classList.toggle('bp-pin-ok', ok)
      el.classList.toggle('bp-pin-dim', !ok)
    })
  }
  private clearPinHints() {
    this.pinEls.forEach((el) => el.classList.remove('bp-pin-ok', 'bp-pin-dim'))
  }

  private tryConnect(
    a: { node: string; pin: string; ptype: PinType },
    b: { node: string; pin: string; dir: 'in' | 'out'; ptype: PinType },
  ) {
    const aDir = this.pinDir(a.node, a.pin)
    if (!aDir || aDir === b.dir) return
    if (a.node === b.node) return
    if (!pinCompatible(a.ptype, b.ptype)) return
    const out = aDir === 'out' ? a : b
    const inp = aDir === 'out' ? b : a
    this.record()
    const spec = NODE_SPECS[this.nodeType(inp.node)]
    const pinSpec = spec.inputs.find((p) => p.id === inp.pin)
    if (!pinSpec?.multi)
      this.edges = this.edges.filter((x) => !(x.to.node === inp.node && x.to.pin === inp.pin))
    if (
      this.edges.some(
        (x) => x.from.node === out.node && x.from.pin === out.pin && x.to.node === inp.node && x.to.pin === inp.pin,
      )
    ) {
      this.history.cancel()
      return
    }
    this.edges.push({ id: uid('e'), from: { node: out.node, pin: out.pin }, to: { node: inp.node, pin: inp.pin } })
    this.renderEdges()
    this.emit()
  }

  /** Double-clicking a wire drops a reroute knot that splits it. */
  private insertReroute(edgeId: string, clientX: number, clientY: number) {
    const e = this.edges.find((x) => x.id === edgeId)
    if (!e) return
    this.record()
    const w = this.toWorld(clientX, clientY)
    const rr: BPNode = { id: uid('n'), type: 'reroute', x: w.x - 7, y: w.y - 7, data: {} }
    this.nodes.push(rr)
    this.edges = this.edges.filter((x) => x.id !== edgeId)
    this.edges.push({ id: uid('e'), from: { ...e.from }, to: { node: rr.id, pin: 'in' } })
    this.edges.push({ id: uid('e'), from: { node: rr.id, pin: 'out' }, to: { ...e.to } })
    this.mountNode(rr)
    this.renderEdges()
    this.emit()
  }

  // ── selection / clipboard ──
  private selectNone() {
    this.selNodes.clear()
    this.selFrames.clear()
    this.selEdge = null
    this.refreshSelection()
    this.renderInspector()
  }
  private selectAll() {
    this.nodes.forEach((n) => this.selNodes.add(n.id))
    this.refreshSelection()
    this.renderInspector()
  }
  private refreshSelection() {
    this.nodeEls.forEach((el, id) => el.classList.toggle('bp-selected', this.selNodes.has(id)))
    this.edgeEls.forEach(({ vis }, id) => vis.classList.toggle('bp-wire-sel', this.selEdge === id))
  }
  private deleteSelection() {
    if (!this.selNodes.size && !this.selEdge && !this.selFrames.size) return
    this.record()
    if (this.selEdge) this.edges = this.edges.filter((e) => e.id !== this.selEdge)
    if (this.selNodes.size) {
      const ids = this.selNodes
      this.nodes = this.nodes.filter((n) => !ids.has(n.id))
      this.edges = this.edges.filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node))
      ids.forEach((id) => {
        this.nodeEls.get(id)?.remove()
        this.nodeEls.delete(id)
      })
    }
    if (this.selFrames.size) {
      this.frames = this.frames.filter((f) => !this.selFrames.has(f.id))
    }
    this.selNodes.clear()
    this.selFrames.clear()
    this.selEdge = null
    this.renderAll()
    this.emit()
  }
  private removeNode(id: string) {
    this.nodes = this.nodes.filter((n) => n.id !== id)
    this.edges = this.edges.filter((e) => e.from.node !== id && e.to.node !== id)
    this.nodeEls.get(id)?.remove()
    this.nodeEls.delete(id)
    this.selNodes.delete(id)
    this.renderEdges()
    this.renderInspector()
  }
  private collectSelection(): BPGraph {
    const ns = this.nodes.filter((n) => this.selNodes.has(n.id))
    const idset = new Set(ns.map((n) => n.id))
    const es = this.edges.filter((e) => idset.has(e.from.node) && idset.has(e.to.node))
    const fs = this.frames.filter((f) => this.selFrames.has(f.id))
    return { nodes: ns.map((n) => ({ ...n, data: { ...n.data } })), edges: es.map((e) => ({ ...e })), frames: fs }
  }
  private copySelection() {
    if (!this.selNodes.size) return
    const txt = JSON.stringify(this.collectSelection())
    try {
      void navigator.clipboard.writeText('xgis-bp:' + txt)
    } catch {
      /* clipboard blocked — internal duplicate still works */
    }
    ;(this as unknown as { _clip: string })._clip = txt
  }
  private spawn(g: BPGraph, dx: number, dy: number) {
    this.record()
    const idmap = new Map<string, string>()
    this.selNodes.clear()
    this.selFrames.clear()
    for (const n of g.nodes) {
      if (NODE_SPECS[n.type].singleton && this.nodes.some((x) => x.type === n.type)) continue
      const nid = uid('n')
      idmap.set(n.id, nid)
      const nn: BPNode = { ...n, id: nid, x: n.x + dx, y: n.y + dy, data: { ...n.data } }
      this.nodes.push(nn)
      this.mountNode(nn)
      this.selNodes.add(nid)
    }
    for (const e of g.edges) {
      const f = idmap.get(e.from.node)
      const t = idmap.get(e.to.node)
      if (f && t) this.edges.push({ id: uid('e'), from: { node: f, pin: e.from.pin }, to: { node: t, pin: e.to.pin } })
    }
    for (const fr of g.frames ?? []) {
      const nf: BPFrame = { ...fr, id: uid('f'), x: fr.x + dx, y: fr.y + dy }
      this.frames.push(nf)
      this.mountFrame(nf)
    }
    this.refreshSelection()
    this.renderInspector()
    this.scheduleRedraw()
    this.emit()
  }
  private duplicateSelection() {
    if (!this.selNodes.size) return
    this.spawn(this.collectSelection(), 36, 36)
  }
  private async pasteClipboard() {
    let txt = ''
    try {
      txt = await navigator.clipboard.readText()
    } catch {
      /* fall back to internal buffer */
    }
    let json = txt.startsWith('xgis-bp:') ? txt.slice(8) : ''
    if (!json) json = (this as unknown as { _clip?: string })._clip ?? ''
    if (!json) return
    try {
      this.spawn(JSON.parse(json), 28, 28)
    } catch {
      /* not a blueprint payload */
    }
  }

  // ── geometry / redraw ──
  private pinDir(node: string, pin: string): 'in' | 'out' | null {
    const el = this.pinEls.get(`${node}:${pin}`)
    return el ? (el.dataset.dir as 'in' | 'out') : null
  }
  private pinType(node: string, pin: string): PinType | null {
    const el = this.pinEls.get(`${node}:${pin}`)
    return el ? (el.dataset.ptype as PinType) : null
  }
  private nodeType(id: string): NodeType {
    return this.nodes.find((n) => n.id === id)!.type
  }
  private pinCenter(node: string, pin: string): { x: number; y: number } | null {
    const el = this.pinEls.get(`${node}:${pin}`)
    if (!el) return null
    // collapsed-frame node → anchor crossing wires to the frame edge
    const nd = this.nodes.find((n) => n.id === node)
    if (nd) {
      const fr = this.frames.find((f) => f.collapsed && this.nodeInFrame(nd, f))
      if (fr) {
        const left = pin === 'in' || NODE_SPECS[nd.type].inputs.some((p) => p.id === pin)
        return { x: left ? fr.x : fr.x + fr.w, y: fr.y + 17 }
      }
    }
    const vp = this.vp.getBoundingClientRect()
    const pr = el.getBoundingClientRect()
    return {
      x: (pr.left + pr.width / 2 - vp.left - this.pan.x) / this.zoom,
      y: (pr.top + pr.height / 2 - vp.top - this.pan.y) / this.zoom,
    }
  }
  private scheduleRedraw() {
    if (this.rafPending) return
    this.rafPending = true
    requestAnimationFrame(() => {
      this.rafPending = false
      this.renderEdges()
      this.drawMini()
    })
  }
  private renderEdges() {
    const live = new Set(this.edges.map((e) => e.id))
    this.edgeEls.forEach(({ hit, vis }, id) => {
      if (!live.has(id)) {
        hit.remove()
        vis.remove()
        this.edgeEls.delete(id)
      }
    })
    for (const e of this.edges) {
      const a = this.pinCenter(e.from.node, e.from.pin)
      const b = this.pinCenter(e.to.node, e.to.pin)
      if (!a || !b) continue
      let pair = this.edgeEls.get(e.id)
      if (!pair) {
        const hit = document.createElementNS(SVGNS, 'path')
        hit.classList.add('bp-wire-hit')
        hit.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation()
          this.selNodes.clear()
          this.selEdge = e.id
          this.refreshSelection()
          this.renderInspector()
        })
        hit.addEventListener('dblclick', (ev) => {
          ev.stopPropagation()
          this.insertReroute(e.id, ev.clientX, ev.clientY)
        })
        const vis = document.createElementNS(SVGNS, 'path')
        vis.classList.add('bp-wire')
        this.gEdges.insertBefore(vis, this.tempPath)
        this.gEdges.insertBefore(hit, this.tempPath)
        pair = { hit, vis }
        this.edgeEls.set(e.id, pair)
      }
      const pt = (this.pinEls.get(`${e.from.node}:${e.from.pin}`)?.dataset.ptype ?? 'layer') as PinType
      const d = bezier(a.x, a.y, b.x, b.y)
      pair.hit.setAttribute('d', d)
      pair.vis.setAttribute('d', d)
      pair.vis.setAttribute('stroke', PIN_COLOR[pt])
      pair.vis.classList.toggle('bp-wire-sel', this.selEdge === e.id)
    }
  }

  // ── minimap ──
  private drawMini() {
    const r = this.vp.getBoundingClientRect()
    renderMinimap(this.mini, {
      nodes: this.nodes,
      sizeOf: (id) => {
        const el = this.nodeEls.get(id)
        return { w: el?.offsetWidth ?? 232, h: el?.offsetHeight ?? 120 }
      },
      pan: this.pan,
      zoom: this.zoom,
      vp: { width: r.width, height: r.height },
    })
  }

  // ── palette (search + contextual create) ──
  private openPalette(clientX: number, clientY: number, from?: { node: string; pin: string; ptype: PinType }) {
    this.ctxWorld = this.toWorld(clientX, clientY)
    const fromDir = from ? this.pinDir(from.node, from.pin) : null
    const wantDir = fromDir === 'out' ? 'in' : 'out'
    const items = (Object.keys(NODE_SPECS) as NodeType[])
      .filter((t) => {
        if (!from) return true
        const spec = NODE_SPECS[t]
        const pins = wantDir === 'in' ? spec.inputs : spec.outputs
        return pins.some((p) => pinCompatible(p.type, from.ptype))
      })
      .map((t) => ({
        type: t,
        title: NODE_SPECS[t].title,
        blurb: NODE_SPECS[t].blurb,
        accent: NODE_SPECS[t].accent,
        disabled: !!NODE_SPECS[t].singleton && this.nodes.some((n) => n.type === t),
      }))
    openSearchPalette(this.palette, {
      vpRect: this.vp.getBoundingClientRect(),
      clientX,
      clientY,
      contextual: !!from,
      items,
      onPick: (t) => this.commitPalette(t, from),
    })
  }
  private commitPalette(t: NodeType, from?: { node: string; pin: string; ptype: PinType }) {
    this.palette.style.display = 'none'
    const id = this.addNode(t, this.ctxWorld.x, this.ctxWorld.y)
    if (id && from) {
      const fromDir = this.pinDir(from.node, from.pin)
      const spec = NODE_SPECS[t]
      const wantPins = fromDir === 'out' ? spec.inputs : spec.outputs
      const target = wantPins.find((p) => pinCompatible(p.type, from.ptype))
      if (target) {
        const a = from
        const b = { node: id, pin: target.id, dir: (fromDir === 'out' ? 'in' : 'out') as 'in' | 'out', ptype: target.type }
        this.tryConnect(a, b)
      }
    }
  }

  // ── inspector ──
  private renderInspector() {
    const box = this.inspectorEl
    if (this.selNodes.size !== 1) {
      if (this.selNodes.size < 2) {
        box.innerHTML = `<div class="bp-insp-empty">Select a node to edit its properties.</div>`
        return
      }
      box.innerHTML = `<div class="bp-insp-h">${this.selNodes.size} nodes selected</div>`
      const row = document.createElement('div')
      row.className = 'bp-insp-align'
      const mk = (label: string, title: string, mode: 'left' | 'top' | 'hdist' | 'vdist') => {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = label
        b.title = title
        b.addEventListener('click', () => this.align(mode))
        return b
      }
      row.append(
        mk('⇤', 'Align left edges', 'left'),
        mk('⤒', 'Align top edges', 'top'),
        mk('↔', 'Distribute horizontally', 'hdist'),
        mk('↕', 'Distribute vertically', 'vdist'),
      )
      box.appendChild(row)
      return
    }
    const n = this.nodes.find((x) => this.selNodes.has(x.id))
    if (!n) return
    const spec = NODE_SPECS[n.type]
    box.innerHTML = `<div class="bp-insp-h"><span class="bp-dot" style="background:${spec.accent}"></span>${spec.title}</div><div class="bp-insp-blurb">${spec.blurb}</div>`
    for (const f of spec.fields) {
      const wrap = document.createElement('label')
      wrap.className = 'bp-field'
      const lab = document.createElement('span')
      lab.className = 'bp-flabel'
      lab.textContent = f.label
      wrap.appendChild(lab)
      let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      if (f.kind === 'select') {
        input = document.createElement('select')
        for (const opt of f.options ?? []) {
          const o = document.createElement('option')
          o.value = opt
          o.textContent = opt
          input.appendChild(o)
        }
        input.value = n.data[f.key] ?? ''
      } else if (f.kind === 'textarea') {
        input = document.createElement('textarea')
        input.rows = 4
        input.value = n.data[f.key] ?? ''
      } else {
        input = document.createElement('input')
        input.type = 'text'
        input.value = n.data[f.key] ?? ''
      }
      input.className = 'bp-input'
      input.addEventListener('focus', () => this.recordFieldOnce())
      input.addEventListener('input', () => {
        n.data[f.key] = input.value
        const cardInput = this.nodeEls
          .get(n.id)
          ?.querySelector<HTMLElement>(`.bp-input[data-k="${f.key}"]`) as
          | HTMLInputElement
          | HTMLTextAreaElement
          | HTMLSelectElement
          | null
        if (cardInput) cardInput.value = input.value
        this.scheduleRedraw()
        this.emit()
      })
      wrap.appendChild(input)
      box.appendChild(wrap)
    }
    if (n.type === 'source') {
      const peek = document.createElement('button')
      peek.type = 'button'
      peek.className = 'bp-insp-peek'
      peek.textContent = 'Peek data'
      const res = document.createElement('div')
      res.className = 'bp-insp-peekres'
      peek.addEventListener('click', () => void peekData(n, res))
      box.append(peek, res)
    }
  }
  private syncInspector(n: BPNode) {
    if (this.selNodes.size === 1 && this.selNodes.has(n.id)) {
      const inputs = this.inspectorEl.querySelectorAll<HTMLElement>('.bp-input')
      const spec = NODE_SPECS[n.type]
      inputs.forEach((el, i) => {
        const f = spec.fields[i]
        if (f) (el as HTMLInputElement).value = n.data[f.key] ?? ''
      })
    }
  }

  private recordFieldOnce() {
    if (this.fieldDirty) return
    this.fieldDirty = true
    this.record()
    setTimeout(() => (this.fieldDirty = false), 600)
  }

  // ── Map order panel ──
  private syncMapNode() {
    const map = this.nodes.find((n) => n.type === 'map')
    if (!map) return
    const el = this.nodeEls.get(map.id)
    const box = el?.querySelector('.bp-order') as HTMLElement | null
    if (!box) return
    const connected = this.edges
      .filter((e) => e.to.node === map.id && e.to.pin === 'layers')
      .map((e) => this.resolveLayer(e.from.node))
      .filter((id): id is string => !!id)
    const stored = (map.data.order || '').split(',').filter(Boolean)
    const ids = [...stored.filter((id) => connected.includes(id)), ...connected.filter((id) => !stored.includes(id))]
    map.data.order = ids.join(',')
    box.innerHTML = '<div class="bp-order-h">draw order — top drawn first (under)</div>'
    if (!ids.length) {
      const hint = document.createElement('div')
      hint.className = 'bp-order-empty'
      hint.textContent = 'Wire layer outputs into this node.'
      box.appendChild(hint)
      return
    }
    ids.forEach((id, i) => {
      const lname = this.nodes.find((n) => n.id === id)?.data.name || 'layer'
      const row = document.createElement('div')
      row.className = 'bp-order-row'
      const up = document.createElement('button')
      up.type = 'button'
      up.className = 'bp-ord-btn'
      up.textContent = '▲'
      up.disabled = i === 0
      const dn = document.createElement('button')
      dn.type = 'button'
      dn.className = 'bp-ord-btn'
      dn.textContent = '▼'
      dn.disabled = i === ids.length - 1
      const move = (delta: number) => {
        const j = i + delta
        if (j < 0 || j >= ids.length) return
        this.record()
        ;[ids[i], ids[j]] = [ids[j], ids[i]]
        map.data.order = ids.join(',')
        this.emit()
      }
      ;[up, dn].forEach((b) => b.addEventListener('pointerdown', (e) => e.stopPropagation()))
      up.addEventListener('click', (e) => {
        e.stopPropagation()
        move(-1)
      })
      dn.addEventListener('click', (e) => {
        e.stopPropagation()
        move(1)
      })
      const lab = document.createElement('span')
      lab.className = 'bp-ord-name'
      lab.textContent = `${i + 1}. ${lname}`
      row.append(up, dn, lab)
      box.appendChild(row)
    })
  }
  /** Follow reroute knots to the real layer node id (for the order panel). */
  private resolveLayer(id: string, seen = new Set<string>()): string | null {
    const n = this.nodes.find((x) => x.id === id)
    if (!n) return null
    if (n.type === 'layer') return id
    if (n.type === 'reroute' && !seen.has(id)) {
      seen.add(id)
      const up = this.edges.find((e) => e.to.node === id && e.to.pin === 'in')
      return up ? this.resolveLayer(up.from.node, seen) : null
    }
    return null
  }

  // ── diagnostics ──
  private updateBadges() {
    const issues = computeNodeIssues(this.nodes, this.edges)
    for (const n of this.nodes) {
      const el = this.nodeEls.get(n.id)
      const badge = el?.querySelector('.bp-badge') as HTMLElement | null
      if (!badge) continue
      const list = issues.get(n.id)
      if (list) {
        badge.style.display = ''
        badge.textContent = '⚠'
        badge.title = list.join(' · ')
      } else {
        badge.style.display = 'none'
      }
    }
  }

  private emit() {
    this.syncMapNode()
    this.updateBadges()
    this.onChange()
  }
}
