// Reverse of codegen: a Mapbox/MapLibre style (OpenFreeMap, MapLibre
// demotiles, any style.json) or raw `.xgis` source → a BPGraph the
// editor can load.
//
// Strategy: lean on the compiler's own `convertMapboxStyle` to get
// `.xgis` text (the exact path the /convert page uses), then split it
// into top-level blocks with a string/comment/brace-aware scanner.
// Structured header fields are read per block; the utility pipeline
// is kept VERBATIM so the full utility grammar round-trips without a
// fragile AST re-serialiser. Only `source:` / `style:` references
// become wires (codegen emits those from edges); everything else
// stays as pipe text and round-trips through the pipe field.

import { convertMapboxStyle } from '@xgis/compiler'
import { defaultData, uid, type BPEdge, type BPGraph, type BPNode, type NodeType } from './types'

/** Split well-formed `.xgis` into top-level statements, ignoring
 *  braces inside strings / comments / match-blocks. Top-level
 *  comments are dropped (consumed without opening a statement). */
function splitBlocks(src: string): string[] {
  const out: string[] = []
  let start = -1
  let depth = 0
  let inStr = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const c2 = src[i + 1]
    if (inLine) {
      if (c === '\n') inLine = false
      continue
    }
    if (inBlock) {
      if (c === '*' && c2 === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '/' && c2 === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && c2 === '*') {
      inBlock = true
      i++
      continue
    }
    if (c === '"') {
      if (start < 0) start = i
      inStr = true
      continue
    }
    if (start < 0 && depth === 0 && /\S/.test(c)) start = i
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(src.slice(start, i + 1).trim())
        start = -1
      }
    } else if (depth === 0 && c === '\n' && start >= 0) {
      const seg = src.slice(start, i).trim()
      if (seg) out.push(seg)
      start = -1
    }
  }
  if (start >= 0) {
    const seg = src.slice(start).trim()
    if (seg) out.push(seg)
  }
  return out
}

function headerName(block: string): string {
  const m = block.match(/^[a-z]+\s+([A-Za-z_][\w-]*)/)
  return m ? m[1] : ''
}

function bodyLines(block: string): string[] {
  const open = block.indexOf('{')
  const close = block.lastIndexOf('}')
  if (open < 0 || close < 0 || close < open) return []
  return block
    .slice(open + 1, close)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** First `key:` value on a line, quotes stripped. */
function prop(lines: string[], key: string): string | undefined {
  const pre = key + ':'
  for (const l of lines) {
    if (l.startsWith(pre)) {
      const v = l.slice(pre.length).trim()
      return v.replace(/^"(.*)"$/, '$1')
    }
  }
  return undefined
}

function pipeText(lines: string[]): string {
  return lines
    .filter((l) => l.startsWith('|'))
    .map((l) => l.replace(/^\|\s*/, '').trim())
    .filter(Boolean)
    .join('\n')
}

function mk(type: NodeType, data: Record<string, string>): BPNode {
  return { id: uid('n'), type, x: 0, y: 0, data: { ...defaultData(type), ...data } }
}

/** Parse `.xgis` source into a graph. Best-effort: unknown blocks are
 *  skipped, `source:` / `style:` refs become wires, every layer is
 *  wired into a single Map sink in document order. */
export function xgisToGraph(src: string): BPGraph {
  const nodes: BPNode[] = []
  const edges: BPEdge[] = []
  const sourceByName = new Map<string, string>()
  const styleByName = new Map<string, string>()
  const layers: { node: BPNode; src?: string; style?: string }[] = []

  for (const block of splitBlocks(src)) {
    const kw = block.match(/^([a-z]+)\b/)?.[1]
    if (!kw) continue
    const name = headerName(block)
    const lines = bodyLines(block)

    if (kw === 'source') {
      const layersProp = prop(lines, 'layers') ?? ''
      const n = mk('source', {
        name,
        type: prop(lines, 'type') || 'geojson',
        url: prop(lines, 'url') || '',
        layers: layersProp
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
          .filter(Boolean)
          .join(', '),
      })
      nodes.push(n)
      if (name) sourceByName.set(name, n.id)
    } else if (kw === 'style') {
      const n = mk('style', {
        name,
        fill: prop(lines, 'fill') || '',
        stroke: prop(lines, 'stroke') || '',
        strokeWidth: prop(lines, 'stroke-width') || '',
        opacity: prop(lines, 'opacity') || '',
      })
      nodes.push(n)
      if (name) styleByName.set(name, n.id)
    } else if (kw === 'preset') {
      nodes.push(mk('preset', { name, pipe: pipeText(lines) }))
    } else if (kw === 'symbol') {
      const pathLine = lines.find((l) => l.startsWith('path '))
      nodes.push(
        mk('symbol', {
          name,
          path: pathLine ? pathLine.slice(5).trim().replace(/^"(.*)"$/, '$1') : '',
          anchor: prop(lines, 'anchor') || 'center',
        }),
      )
    } else if (kw === 'background') {
      nodes.push(mk('background', { fill: prop(lines, 'fill') || 'sky-900' }))
    } else if (kw === 'import') {
      const named = block.match(/^import\s*\{([^}]*)\}\s*from\s*"([^"]*)"/)
      const splice = block.match(/^import\s+"([^"]*)"/)
      if (named)
        nodes.push(
          mk('import', {
            mode: 'named',
            names: named[1].split(',').map((s) => s.trim()).filter(Boolean).join(', '),
            path: named[2],
          }),
        )
      else if (splice) nodes.push(mk('import', { mode: 'splice', path: splice[1] }))
    } else if (kw === 'fn') {
      const sig = block.match(/^fn\s+[A-Za-z_]\w*\s*\(([^)]*)\)\s*(?:->\s*([A-Za-z_]\w*))?/)
      nodes.push(
        mk('fn', {
          name,
          params: sig?.[1]?.trim() || '',
          ret: sig?.[2]?.trim() || '',
          body: lines.join('\n'),
        }),
      )
    } else if (kw === 'layer') {
      const n = mk('layer', {
        name,
        sourceLayer: prop(lines, 'sourceLayer') || '',
        minzoom: prop(lines, 'minzoom') || '',
        maxzoom: prop(lines, 'maxzoom') || '',
        filter: prop(lines, 'filter') || '',
        pipe: pipeText(lines),
      })
      nodes.push(n)
      layers.push({ node: n, src: prop(lines, 'source'), style: prop(lines, 'style') })
    }
  }

  // Map sink + wires. Codegen only emits source:/style: from edges,
  // so those refs must become real connections.
  const map = mk('map', {})
  nodes.push(map)
  for (const { node, src: s, style: st } of layers) {
    if (s && sourceByName.has(s))
      edges.push({ id: uid('e'), from: { node: sourceByName.get(s)!, pin: 'out' }, to: { node: node.id, pin: 'source' } })
    if (st && styleByName.has(st))
      edges.push({ id: uid('e'), from: { node: styleByName.get(st)!, pin: 'out' }, to: { node: node.id, pin: 'style' } })
    edges.push({ id: uid('e'), from: { node: node.id, pin: 'out' }, to: { node: map.id, pin: 'layers' } })
  }

  autoLayout(nodes)
  return { nodes, edges }
}

/** Columns by role; layers wrap so a 100-layer basemap stays
 *  pannable rather than one impossibly tall stack. */
function autoLayout(nodes: BPNode[]) {
  const col = (t: NodeType) =>
    t === 'source'
      ? 1
      : t === 'layer'
        ? 2
        : t === 'map'
          ? 3
          : 0 // import/fn/symbol/style/preset/background
  const yByCol = new Map<number, number>()
  const xByCol = [40, 340, 660, 0]
  const layerCount = nodes.filter((n) => n.type === 'layer').length
  let layerIdx = 0
  for (const n of nodes) {
    const c = col(n.type)
    if (n.type === 'layer') {
      const perCol = 12
      const colN = Math.floor(layerIdx / perCol)
      n.x = 660 + colN * 280
      n.y = 40 + (layerIdx % perCol) * 168
      layerIdx++
      continue
    }
    if (n.type === 'map') {
      const cols = Math.max(1, Math.ceil(layerCount / 12))
      n.x = 660 + cols * 280 + 40
      n.y = 120
      continue
    }
    const y = yByCol.get(c) ?? 40
    n.x = xByCol[c]
    n.y = y
    yByCol.set(c, y + (n.type === 'source' ? 190 : 150))
  }
}

/** A Mapbox/MapLibre style object → graph (via the compiler's own
 *  converter, same as /convert). Throws on invalid JSON upstream. */
export function styleToGraph(style: unknown): BPGraph {
  return xgisToGraph(convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0]))
}

/** Heuristic dispatch for the paste box: JSON → style import,
 *  otherwise treat the text as raw `.xgis`. */
export function importText(text: string): BPGraph {
  const t = text.trim()
  if (t.startsWith('{')) return styleToGraph(JSON.parse(t))
  return xgisToGraph(t)
}
