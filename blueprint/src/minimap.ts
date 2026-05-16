// Minimap renderer. Self-contained: given the graph + view transform
// it (re)builds the corner overview. Only shown on busy graphs.

import { NODE_SPECS, type BPNode } from './types'

interface MinimapView {
  nodes: BPNode[]
  sizeOf: (id: string) => { w: number; h: number }
  pan: { x: number; y: number }
  zoom: number
  vp: { width: number; height: number }
}

export function renderMinimap(mini: HTMLElement, v: MinimapView): void {
  const ns = v.nodes
  // Only worth the corner real-estate on busy graphs; keep the
  // canvas clean for the common small case.
  if (ns.length < 12) {
    mini.style.display = 'none'
    mini.innerHTML = ''
    return
  }
  mini.style.display = ''
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of ns) {
    const { w, h } = v.sizeOf(n.id)
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + w)
    maxY = Math.max(maxY, n.y + h)
  }
  const pad = 80
  minX -= pad
  minY -= pad
  maxX += pad
  maxY += pad
  const MW = 180
  const MH = 120
  const s = Math.min(MW / (maxX - minX), MH / (maxY - minY))
  let html = ''
  for (const n of ns) {
    const sz = v.sizeOf(n.id)
    const w = sz.w * s
    const h = sz.h * s
    html += `<i style="left:${(n.x - minX) * s}px;top:${(n.y - minY) * s}px;width:${Math.max(2, w)}px;height:${Math.max(2, h)}px;background:${NODE_SPECS[n.type].accent}"></i>`
  }
  const vx = (-v.pan.x / v.zoom - minX) * s
  const vy = (-v.pan.y / v.zoom - minY) * s
  const vw = (v.vp.width / v.zoom) * s
  const vh = (v.vp.height / v.zoom) * s
  html += `<b style="left:${vx}px;top:${vy}px;width:${vw}px;height:${vh}px"></b>`
  mini.innerHTML = html
}
