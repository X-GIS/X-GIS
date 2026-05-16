// Graph → `.xgis` source. Walks the blueprint and emits one block per
// definition node; wires set the textual cross-references (a layer's
// source:/style:/apply-/symbol-). Emission order matches how the
// language is normally written: imports, sources, symbols, styles,
// fns, presets, background, then layers in Map draw order.

import type { BPGraph, BPNode } from './types'

function byId(g: BPGraph): Map<string, BPNode> {
  return new Map(g.nodes.map((n) => [n.id, n]))
}

/** Source node ids feeding a given (node,pin) input, in wire order.
 *  Reroute knots are transparent: a wire arriving from a reroute
 *  resolves to whatever feeds the reroute's `in` pin (recursively). */
function incoming(g: BPGraph, node: string, pin: string): string[] {
  const types = new Map(g.nodes.map((n) => [n.id, n.type]))
  const out: string[] = []
  const walk = (nId: string, pId: string, seen: Set<string>) => {
    for (const e of g.edges) {
      if (e.to.node !== nId || e.to.pin !== pId) continue
      if (types.get(e.from.node) === 'reroute') {
        if (seen.has(e.from.node)) continue // guard against wire loops
        walk(e.from.node, 'in', new Set(seen).add(e.from.node))
      } else {
        out.push(e.from.node)
      }
    }
  }
  walk(node, pin, new Set())
  return out
}

function nameOf(n: BPNode | undefined, fallback: string): string {
  const v = n?.data.name?.trim()
  return v && v.length > 0 ? v : fallback
}

/** Split a free-text utility area into trimmed non-empty lines,
 *  tolerating a leading `|` the user may or may not have typed. */
function pipeLines(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split('\n')
    .map((l) => l.trim().replace(/^\|\s*/, '').trim())
    .filter((l) => l.length > 0)
}

function emitSource(n: BPNode): string {
  const d = n.data
  const lines: string[] = [`source ${nameOf(n, 'source')} {`]
  lines.push(`  type: ${d.type?.trim() || 'geojson'}`)
  if (d.url?.trim()) lines.push(`  url: ${JSON.stringify(d.url.trim())}`)
  const layers = (d.layers || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (layers.length === 1) lines.push(`  layers: ${JSON.stringify(layers[0])}`)
  else if (layers.length > 1)
    lines.push(`  layers: [${layers.map((l) => JSON.stringify(l)).join(', ')}]`)
  lines.push('}')
  return lines.join('\n')
}

function emitSymbol(n: BPNode): string {
  const d = n.data
  const lines: string[] = [`symbol ${nameOf(n, 'symbol')} {`]
  if (d.path?.trim()) lines.push(`  path ${JSON.stringify(d.path.trim())}`)
  if (d.anchor?.trim()) lines.push(`  anchor: ${d.anchor.trim()}`)
  lines.push('}')
  return lines.join('\n')
}

function emitStyle(n: BPNode): string {
  const d = n.data
  const lines: string[] = [`style ${nameOf(n, 'style')} {`]
  if (d.fill?.trim()) lines.push(`  fill: ${d.fill.trim()}`)
  if (d.stroke?.trim()) lines.push(`  stroke: ${d.stroke.trim()}`)
  if (d.strokeWidth?.trim()) lines.push(`  stroke-width: ${d.strokeWidth.trim()}`)
  if (d.opacity?.trim()) lines.push(`  opacity: ${d.opacity.trim()}`)
  lines.push('}')
  return lines.join('\n')
}

function emitPreset(n: BPNode): string {
  const lines: string[] = [`preset ${nameOf(n, 'preset')} {`]
  for (const l of pipeLines(n.data.pipe)) lines.push(`  | ${l}`)
  lines.push('}')
  return lines.join('\n')
}

function emitFn(n: BPNode): string {
  const d = n.data
  const ret = d.ret?.trim() ? ` -> ${d.ret.trim()}` : ''
  const body = (d.body || '').trim()
  const indented = body
    .split('\n')
    .map((l) => (l.trim() ? `  ${l.trim()}` : ''))
    .join('\n')
  return `fn ${nameOf(n, 'fn')}(${(d.params || '').trim()})${ret} {\n${indented}\n}`
}

function emitImport(n: BPNode): string {
  const d = n.data
  const path = JSON.stringify((d.path || '').trim())
  if (d.mode === 'named') {
    const names = (d.names || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ')
    return `import { ${names} } from ${path}`
  }
  return `import ${path}`
}

function emitBackground(n: BPNode): string {
  const f = n.data.fill?.trim()
  return f ? `background { fill: ${f} }` : 'background { }'
}

function emitLayer(g: BPGraph, n: BPNode, nodes: Map<string, BPNode>): string {
  const d = n.data
  const lines: string[] = [`layer ${nameOf(n, 'layer')} {`]

  const srcIds = incoming(g, n.id, 'source')
  if (srcIds.length > 0) {
    lines.push(`  source: ${nameOf(nodes.get(srcIds[0]), 'source')}`)
  } else {
    lines.push('  // ⚠ no source wired')
  }

  if (d.sourceLayer?.trim()) lines.push(`  sourceLayer: ${JSON.stringify(d.sourceLayer.trim())}`)
  if (d.minzoom?.trim()) lines.push(`  minzoom: ${d.minzoom.trim()}`)
  if (d.maxzoom?.trim()) lines.push(`  maxzoom: ${d.maxzoom.trim()}`)
  if (d.filter?.trim()) lines.push(`  filter: ${d.filter.trim()}`)

  const styleIds = incoming(g, n.id, 'style')
  if (styleIds.length > 0) lines.push(`  style: ${nameOf(nodes.get(styleIds[0]), 'style')}`)

  // Pipeline + connected presets/symbols folded into the utility lines.
  const pipes = pipeLines(d.pipe)
  const extras: string[] = []
  for (const id of incoming(g, n.id, 'apply'))
    extras.push(`apply-${nameOf(nodes.get(id), 'preset')}`)
  const symIds = incoming(g, n.id, 'symbol')
  if (symIds.length > 0) extras.push(`symbol-${nameOf(nodes.get(symIds[0]), 'symbol')}`)

  if (extras.length > 0) {
    if (pipes.length > 0) pipes[0] = `${extras.join(' ')} ${pipes[0]}`
    else pipes.push(extras.join(' '))
  }
  for (const p of pipes) lines.push(`  | ${p}`)

  lines.push('}')
  return lines.join('\n')
}

export function graphToXgis(g: BPGraph): string {
  const nodes = byId(g)
  const blocks: string[] = []
  const pick = (t: string) => g.nodes.filter((n) => n.type === t)

  for (const n of pick('import')) blocks.push(emitImport(n))
  for (const n of pick('source')) blocks.push(emitSource(n))
  for (const n of pick('symbol')) blocks.push(emitSymbol(n))
  for (const n of pick('style')) blocks.push(emitStyle(n))
  for (const n of pick('fn')) blocks.push(emitFn(n))
  for (const n of pick('preset')) blocks.push(emitPreset(n))

  const bg = pick('background')[0]
  if (bg) blocks.push(emitBackground(bg))

  // Layers: draw order is the Map node's explicit order list
  // (data.order), reconciled with what's actually wired — stored ids
  // still connected keep their slot; newly-wired layers append; any
  // unwired layer still emits last so nothing silently vanishes.
  const mapNode = pick('map')[0]
  const ordered: BPNode[] = []
  const seen = new Set<string>()
  if (mapNode) {
    const connected = incoming(g, mapNode.id, 'layers')
    const connSet = new Set(connected)
    const stored = (mapNode.data.order || '').split(',').filter(Boolean)
    const finalIds = [
      ...stored.filter((id) => connSet.has(id)),
      ...connected.filter((id) => !stored.includes(id)),
    ]
    for (const id of finalIds) {
      const ln = nodes.get(id)
      if (ln && ln.type === 'layer' && !seen.has(id)) {
        ordered.push(ln)
        seen.add(id)
      }
    }
  }
  for (const ln of pick('layer')) if (!seen.has(ln.id)) ordered.push(ln)
  for (const ln of ordered) blocks.push(emitLayer(g, ln, nodes))

  return blocks.join('\n\n') + (blocks.length ? '\n' : '')
}
