// Vanilla DOM + SVG node editor — Unreal-Blueprint flavour:
// draggable node cards with typed input/output pins, bezier wires,
// canvas pan/zoom, right-click "add node" palette. No framework, no
// deps (matches the site's zero-runtime convention).
//
// Geometry model: a `world` <div> (CSS transform translate+scale)
// holds absolutely-positioned node cards; an <svg><g> with the same
// transform holds the wires. Wire endpoints are read back from the
// live pin DOM rects (screen→world), so cards of any height stay
// connected without a hand-maintained layout.

import {
  NODE_SPECS,
  PIN_COLOR,
  defaultData,
  uid,
  type BPEdge,
  type BPGraph,
  type BPNode,
  type NodeType,
  type PinSpec,
} from './types'

type Sel = { kind: 'node' | 'edge'; id: string } | null

interface Opts {
  viewport: HTMLElement
  onChange: () => void
}

const SVGNS = 'http://www.w3.org/2000/svg'

export class BlueprintEditor {
  private vp: HTMLElement
  private world!: HTMLElement
  private svg!: SVGSVGElement
  private gEdges!: SVGGElement
  private tempPath!: SVGPathElement
  private ctx!: HTMLElement
  private onChange: () => void

  private nodes: BPNode[] = []
  private edges: BPEdge[] = []
  private pan = { x: 40, y: 40 }
  private zoom = 1
  private zTop = 1

  private nodeEls = new Map<string, HTMLElement>()
  private pinEls = new Map<string, HTMLElement>()
  private edgeEls = new Map<string, { hit: SVGPathElement; vis: SVGPathElement }>()
  private sel: Sel = null

  // transient interaction state
  private drag:
    | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
    | { kind: 'node'; id: string; offx: number; offy: number }
    | { kind: 'wire'; from: { node: string; pin: string; ptype: string } }
    | null = null
  private ctxWorld = { x: 0, y: 0 }
  private rafPending = false

  constructor(o: Opts) {
    this.vp = o.viewport
    this.onChange = o.onChange
    this.build()
    this.wire()
  }

  // ── public API ──
  load(g: BPGraph) {
    this.nodes = g.nodes.map((n) => ({ ...n, data: { ...n.data } }))
    this.edges = g.edges.map((e) => ({ ...e }))
    this.renderAll()
    this.emit()
  }
  getGraph(): BPGraph {
    return {
      nodes: this.nodes.map((n) => ({ ...n, data: { ...n.data } })),
      edges: this.edges.map((e) => ({ ...e })),
    }
  }
  clear() {
    this.nodes = []
    this.edges = []
    this.sel = null
    this.renderAll()
    this.emit()
  }
  resetView() {
    this.pan = { x: 40, y: 40 }
    this.zoom = 1
    this.applyTransform()
    this.scheduleRedraw()
  }
  addNode(type: NodeType, wx?: number, wy?: number) {
    if (NODE_SPECS[type].singleton && this.nodes.some((n) => n.type === type)) {
      return
    }
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

    this.ctx = document.createElement('div')
    this.ctx.className = 'bp-ctx'
    this.ctx.style.display = 'none'

    this.vp.append(this.svg, this.world, this.ctx)
    this.resizeSvg()
    this.applyTransform()
  }

  private wire() {
    // pan / deselect on empty-canvas press
    this.vp.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return
      const t = e.target as HTMLElement
      if (t === this.vp || t === this.world || t === (this.svg as unknown as HTMLElement)) {
        this.select(null)
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
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
        const z = Math.min(2.4, Math.max(0.25, this.zoom * factor))
        // keep the point under the cursor fixed
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
      this.openCtx(e.clientX, e.clientY)
    })
    this.vp.addEventListener('pointerdown', (e) => {
      if (!this.ctx.contains(e.target as Node)) this.ctx.style.display = 'none'
    })

    window.addEventListener('keydown', (e) => {
      const ae = document.activeElement as HTMLElement | null
      if (ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) {
        e.preventDefault()
        if (this.sel.kind === 'node') this.removeNode(this.sel.id)
        else this.removeEdge(this.sel.id)
      }
      if (e.key === 'Escape') this.cancelWire()
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
    const t = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`
    this.world.style.transform = t
    this.gEdges.setAttribute(
      'transform',
      `translate(${this.pan.x},${this.pan.y}) scale(${this.zoom})`,
    )
  }

  // ── render ──
  private renderAll() {
    this.nodeEls.forEach((el) => el.remove())
    this.nodeEls.clear()
    this.pinEls.clear()
    this.edgeEls.forEach(({ hit, vis }) => {
      hit.remove()
      vis.remove()
    })
    this.edgeEls.clear()
    for (const n of this.nodes) this.mountNode(n)
    this.scheduleRedraw()
  }

  private mountNode(n: BPNode) {
    const spec = NODE_SPECS[n.type]
    const card = document.createElement('div')
    card.className = 'bp-node'
    card.style.left = `${n.x}px`
    card.style.top = `${n.y}px`
    card.style.zIndex = String((this.zTop += 1))
    card.dataset.id = n.id

    const head = document.createElement('div')
    head.className = 'bp-head'
    head.style.setProperty('--accent', spec.accent)
    head.innerHTML = `<span class="bp-dot"></span><span class="bp-title">${spec.title}</span>`
    const del = document.createElement('button')
    del.className = 'bp-del'
    del.type = 'button'
    del.title = 'Delete node'
    del.textContent = '×'
    del.addEventListener('pointerdown', (e) => e.stopPropagation())
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      this.removeNode(n.id)
    })
    head.appendChild(del)
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      this.select({ kind: 'node', id: n.id })
      card.style.zIndex = String((this.zTop += 1))
      const r = this.vp.getBoundingClientRect()
      const mx = (e.clientX - r.left - this.pan.x) / this.zoom
      const my = (e.clientY - r.top - this.pan.y) / this.zoom
      this.drag = { kind: 'node', id: n.id, offx: mx - n.x, offy: my - n.y }
      document.body.classList.add('bp-grabbing')
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

    if (spec.fields.length) {
      const fields = document.createElement('div')
      fields.className = 'bp-fields'
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
        input.addEventListener('pointerdown', (e) => e.stopPropagation())
        const handler = () => {
          n.data[f.key] = input.value
          if (f.kind === 'textarea') this.scheduleRedraw()
          this.emit()
        }
        input.addEventListener('input', handler)
        input.addEventListener('change', handler)
        wrap.appendChild(input)
        fields.appendChild(wrap)
      }
      card.appendChild(fields)
    }

    this.world.appendChild(card)
    this.nodeEls.set(n.id, card)
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

  // ── interaction ──
  private onMove(e: PointerEvent) {
    if (!this.drag) return
    const r = this.vp.getBoundingClientRect()
    if (this.drag.kind === 'pan') {
      this.pan.x = this.drag.px + (e.clientX - this.drag.sx)
      this.pan.y = this.drag.py + (e.clientY - this.drag.sy)
      this.applyTransform()
      this.scheduleRedraw()
    } else if (this.drag.kind === 'node') {
      const n = this.nodes.find((x) => x.id === (this.drag as any).id)
      if (!n) return
      n.x = (e.clientX - r.left - this.pan.x) / this.zoom - this.drag.offx
      n.y = (e.clientY - r.top - this.pan.y) / this.zoom - this.drag.offy
      const el = this.nodeEls.get(n.id)
      if (el) {
        el.style.left = `${n.x}px`
        el.style.top = `${n.y}px`
      }
      this.scheduleRedraw()
    } else if (this.drag.kind === 'wire') {
      const wx = (e.clientX - r.left - this.pan.x) / this.zoom
      const wy = (e.clientY - r.top - this.pan.y) / this.zoom
      const a = this.pinCenter(this.drag.from.node, this.drag.from.pin)
      if (a) {
        this.tempPath.style.display = ''
        this.tempPath.setAttribute('stroke', PIN_COLOR[this.drag.from.ptype as keyof typeof PIN_COLOR])
        this.tempPath.setAttribute('d', bezier(a.x, a.y, wx, wy))
      }
    }
  }

  private onUp(e: PointerEvent) {
    const d = this.drag
    this.drag = null
    document.body.classList.remove('bp-grabbing')
    if (!d) return
    if (d.kind === 'node') this.emit()
    if (d.kind === 'wire') {
      this.tempPath.style.display = 'none'
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      if (el && el.classList.contains('bp-pin')) {
        this.tryConnect(d.from, {
          node: el.dataset.node!,
          pin: el.dataset.pin!,
          dir: el.dataset.dir as 'in' | 'out',
          ptype: el.dataset.ptype!,
        })
      }
    }
  }

  private startWire(nodeId: string, p: PinSpec, dir: 'in' | 'out') {
    // Re-grabbing an occupied input detaches its wire for re-routing.
    if (dir === 'in') {
      const ex = this.edges.find((x) => x.to.node === nodeId && x.to.pin === p.id)
      if (ex) {
        const fromNode = ex.from.node
        const fromPin = ex.from.pin
        this.edges = this.edges.filter((x) => x.id !== ex.id)
        this.renderEdges()
        this.emit()
        this.drag = { kind: 'wire', from: { node: fromNode, pin: fromPin, ptype: p.type } }
        return
      }
    }
    this.drag = { kind: 'wire', from: { node: nodeId, pin: p.id, ptype: p.type } }
  }

  private cancelWire() {
    if (this.drag?.kind === 'wire') {
      this.tempPath.style.display = 'none'
      this.drag = null
    }
  }

  private tryConnect(
    a: { node: string; pin: string; ptype: string },
    b: { node: string; pin: string; dir: 'in' | 'out'; ptype: string },
  ) {
    // a is whatever the user grabbed (always treated as the "from"
    // end of the drag). Resolve which side is the output.
    const aDir = this.pinDir(a.node, a.pin)
    if (!aDir || aDir === b.dir) return // need one out + one in
    if (a.node === b.node) return
    if (a.ptype !== b.ptype) return
    const out = aDir === 'out' ? a : b
    const inp = aDir === 'out' ? b : a
    // single-capacity input → replace
    const spec = NODE_SPECS[this.nodeType(inp.node)]
    const pinSpec = spec.inputs.find((p) => p.id === inp.pin)
    if (!pinSpec?.multi) {
      this.edges = this.edges.filter((x) => !(x.to.node === inp.node && x.to.pin === inp.pin))
    }
    if (
      this.edges.some(
        (x) =>
          x.from.node === out.node &&
          x.from.pin === out.pin &&
          x.to.node === inp.node &&
          x.to.pin === inp.pin,
      )
    )
      return
    this.edges.push({
      id: uid('e'),
      from: { node: out.node, pin: out.pin },
      to: { node: inp.node, pin: inp.pin },
    })
    this.renderEdges()
    this.emit()
  }

  private removeNode(id: string) {
    this.nodes = this.nodes.filter((n) => n.id !== id)
    this.edges = this.edges.filter((e) => e.from.node !== id && e.to.node !== id)
    const el = this.nodeEls.get(id)
    if (el) el.remove()
    this.nodeEls.delete(id)
    if (this.sel?.id === id) this.sel = null
    this.renderEdges()
    this.emit()
  }

  private removeEdge(id: string) {
    this.edges = this.edges.filter((e) => e.id !== id)
    if (this.sel?.id === id) this.sel = null
    this.renderEdges()
    this.emit()
  }

  private select(s: Sel) {
    this.sel = s
    this.nodeEls.forEach((el, id) =>
      el.classList.toggle('bp-selected', s?.kind === 'node' && s.id === id),
    )
    this.edgeEls.forEach(({ vis }, id) =>
      vis.classList.toggle('bp-wire-sel', s?.kind === 'edge' && s.id === id),
    )
  }

  // ── geometry / redraw ──
  private pinDir(node: string, pin: string): 'in' | 'out' | null {
    const el = this.pinEls.get(`${node}:${pin}`)
    return el ? (el.dataset.dir as 'in' | 'out') : null
  }
  private nodeType(id: string): NodeType {
    return this.nodes.find((n) => n.id === id)!.type
  }
  private pinCenter(node: string, pin: string): { x: number; y: number } | null {
    const el = this.pinEls.get(`${node}:${pin}`)
    if (!el) return null
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
          this.select({ kind: 'edge', id: e.id })
        })
        const vis = document.createElementNS(SVGNS, 'path')
        vis.classList.add('bp-wire')
        this.gEdges.insertBefore(vis, this.tempPath)
        this.gEdges.insertBefore(hit, this.tempPath)
        pair = { hit, vis }
        this.edgeEls.set(e.id, pair)
      }
      const ptype = (this.pinEls.get(`${e.from.node}:${e.from.pin}`)?.dataset.ptype ??
        'layer') as keyof typeof PIN_COLOR
      const d = bezier(a.x, a.y, b.x, b.y)
      pair.hit.setAttribute('d', d)
      pair.vis.setAttribute('d', d)
      pair.vis.setAttribute('stroke', PIN_COLOR[ptype])
      pair.vis.classList.toggle(
        'bp-wire-sel',
        this.sel?.kind === 'edge' && this.sel.id === e.id,
      )
    }
  }

  // ── context menu ──
  private openCtx(clientX: number, clientY: number) {
    const r = this.vp.getBoundingClientRect()
    this.ctxWorld = {
      x: (clientX - r.left - this.pan.x) / this.zoom,
      y: (clientY - r.top - this.pan.y) / this.zoom,
    }
    this.ctx.innerHTML = '<div class="bp-ctx-h">Add node</div>'
    ;(Object.keys(NODE_SPECS) as NodeType[]).forEach((t) => {
      const spec = NODE_SPECS[t]
      const disabled =
        !!spec.singleton && this.nodes.some((n) => n.type === t)
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'bp-ctx-item'
      item.disabled = disabled
      item.innerHTML =
        `<span class="bp-ctx-dot" style="background:${spec.accent}"></span>` +
        `<span><b>${spec.title}</b><small>${spec.blurb}</small></span>`
      item.addEventListener('click', () => {
        this.ctx.style.display = 'none'
        this.addNode(t, this.ctxWorld.x, this.ctxWorld.y)
      })
      this.ctx.appendChild(item)
    })
    this.ctx.style.left = `${clientX - r.left}px`
    this.ctx.style.top = `${clientY - r.top}px`
    this.ctx.style.display = ''
  }

  private emit() {
    this.onChange()
  }
}

/** Horizontal-tangent cubic bezier between two world points. */
function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(30, Math.min(160, Math.abs(x2 - x1) * 0.5))
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}
