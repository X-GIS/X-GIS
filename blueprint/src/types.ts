// Node/edge/graph model + per-node-type specs for the visual
// blueprint editor.
//
// The node catalogue is DERIVED from @xgis/compiler's LANGUAGE_SCHEMA
// (the single source of truth for language constructs) merged with a
// thin local presentation overlay (titles/colours/field rendering).
// Two nodes — `map` (output sink) and `reroute` (wire knot) — are
// editor-only concepts, not language constructs, so they are authored
// here, outside the schema. A conformance test pins the codegen
// contract (field keys + pin ids) so this cannot drift.

import { LANGUAGE_SCHEMA, type ConstructDef } from '@xgis/compiler'

export type PinType = 'source' | 'style' | 'preset' | 'symbol' | 'layer' | 'any'

/** Wire colour per data type — kept distinct so a glance at the
 *  canvas reads the dependency graph (Unreal-style typed pins). */
export const PIN_COLOR: Record<PinType, string> = {
  source: '#f5a623', // amber  — data sources
  style: '#a78bfa', // violet — named styles
  preset: '#34d399', // emerald— reusable utility combos
  symbol: '#f472b6', // pink   — vector symbols
  layer: '#2997ff', // blue   — rendered layers (site accent)
  any: '#8a8f98', // grey   — reroute (adopts whatever flows through)
}

/** Two pin types may connect when equal, or when either is the
 *  wildcard `any` (reroute knots). */
export function pinCompatible(a: PinType, b: PinType): boolean {
  return a === b || a === 'any' || b === 'any'
}

export interface PinSpec {
  id: string
  label: string
  type: PinType
  /** Input pins only: accept more than one incoming wire. */
  multi?: boolean
  required?: boolean
}

export interface FieldSpec {
  key: string
  label: string
  kind: 'text' | 'textarea' | 'select'
  options?: string[]
  placeholder?: string
}

export type NodeType =
  | 'import'
  | 'source'
  | 'symbol'
  | 'style'
  | 'preset'
  | 'fn'
  | 'layer'
  | 'background'
  | 'map'
  | 'reroute'

/** Catalogue grouping for a Blender/Unreal-style add palette. */
export type NodeCategory = 'Data' | 'Style' | 'Render' | 'Logic' | 'Output' | 'Util'

export interface NodeSpec {
  type: NodeType
  title: string
  accent: string
  blurb: string
  category: NodeCategory
  fields: FieldSpec[]
  inputs: PinSpec[]
  outputs: PinSpec[]
  /** Only one instance allowed (the `map` output sink). */
  singleton?: boolean
  /** A pass-through knot — never emitted; connections resolve
   *  transitively through it. Rendered as a tiny dot. */
  passthrough?: boolean
}

/** A comment frame: a titled, coloured region that groups nodes.
 *  Purely visual — codegen ignores frames entirely. */
export interface BPFrame {
  id: string
  x: number
  y: number
  w: number
  h: number
  title: string
  color: string
  collapsed?: boolean
}

// ── Presentation overlay ──────────────────────────────────────────
// Language facts (which fields/pins exist, their value kinds, enum
// options) come from LANGUAGE_SCHEMA. This overlay only says how to
// render them: human labels, accent colour, blurb, the input widget,
// the output-pin label, and freshly-dropped defaults.

interface FieldUI {
  label: string
  kind: 'text' | 'textarea' | 'select'
  placeholder?: string
}
interface Presentation {
  title: string
  accent: string
  blurb: string
  outLabel?: string
  fields: Record<string, FieldUI>
  defaults: Record<string, string>
}

const PRESENTATION: Record<string, Presentation> = {
  import: {
    title: 'Import',
    accent: '#94a3b8',
    blurb: 'Pull symbols/presets from a file, or splice an entire style.',
    fields: {
      mode: { label: 'Mode', kind: 'select' },
      names: { label: 'Names (named only)', kind: 'text', placeholder: 'railway_tie, cliff_tooth' },
      path: { label: 'Path / URL', kind: 'text', placeholder: 'https://tiles.openfreemap.org/styles/bright' },
    },
    defaults: { mode: 'splice', names: '', path: '' },
  },
  source: {
    title: 'Source',
    accent: PIN_COLOR.source,
    blurb: 'A data source feeding one or more layers.',
    outLabel: 'source',
    fields: {
      name: { label: 'Name', kind: 'text', placeholder: 'world' },
      type: { label: 'Type', kind: 'select' },
      url: { label: 'URL', kind: 'text', placeholder: 'land.geojson' },
      layers: { label: 'MVT layers (opt, comma)', kind: 'text', placeholder: 'water, roads' },
    },
    defaults: { name: 'world', type: 'geojson', url: 'land.geojson', layers: '' },
  },
  symbol: {
    title: 'Symbol',
    accent: PIN_COLOR.symbol,
    blurb: 'A vector glyph referenced by symbol-/shape- utilities.',
    outLabel: 'symbol',
    fields: {
      name: { label: 'Name', kind: 'text', placeholder: 'arrow' },
      path: { label: 'SVG path', kind: 'text', placeholder: 'M 0 -1 L -0.4 0.3 L 0.4 0.3 Z' },
      anchor: { label: 'Anchor', kind: 'select' },
    },
    defaults: { name: 'arrow', path: 'M 0 -1 L -0.4 0.3 L 0.4 0.3 Z', anchor: 'center' },
  },
  style: {
    title: 'Style',
    accent: PIN_COLOR.style,
    blurb: 'A named style block consumed via a layer’s style: field.',
    outLabel: 'style',
    fields: {
      name: { label: 'Name', kind: 'text', placeholder: 'dark_land' },
      fill: { label: 'fill', kind: 'text', placeholder: 'stone-800' },
      stroke: { label: 'stroke', kind: 'text', placeholder: 'slate-600' },
      strokeWidth: { label: 'stroke-width', kind: 'text', placeholder: '1' },
      opacity: { label: 'opacity', kind: 'text', placeholder: '0.8' },
    },
    defaults: { name: 'land', fill: 'stone-800', stroke: '', strokeWidth: '', opacity: '' },
  },
  preset: {
    title: 'Preset',
    accent: PIN_COLOR.preset,
    blurb: 'A reusable utility combo applied via apply-<name>.',
    outLabel: 'preset',
    fields: {
      name: { label: 'Name', kind: 'text', placeholder: 'alert_track' },
      pipe: {
        label: 'Utilities (one pipeline per line)',
        kind: 'textarea',
        placeholder: 'symbol-arrow fill-red-500 glow-8\nanimate-pulse-1s',
      },
    },
    defaults: { name: 'alert_track', pipe: 'fill-red-500 stroke-white stroke-2' },
  },
  fn: {
    title: 'Function',
    accent: '#60a5fa',
    blurb: 'A user function usable inside [bracket] expressions.',
    fields: {
      name: { label: 'Name', kind: 'text', placeholder: 'threat_size' },
      params: { label: 'Params', kind: 'text', placeholder: 'level: f32' },
      ret: { label: 'Return type', kind: 'text', placeholder: 'f32' },
      body: { label: 'Body', kind: 'textarea', placeholder: 'clamp(level * 4, 8, 32)' },
    },
    defaults: { name: 'threat_size', params: 'level: f32', ret: 'f32', body: 'clamp(level * 4, 8, 32)' },
  },
  layer: {
    title: 'Layer',
    accent: PIN_COLOR.layer,
    blurb: 'A rendered layer: a source styled by a utility pipeline.',
    outLabel: 'layer',
    fields: {
      name: { label: 'Name', kind: 'text', placeholder: 'districts' },
      sourceLayer: { label: 'sourceLayer (opt)', kind: 'text', placeholder: 'water' },
      minzoom: { label: 'minzoom (opt)', kind: 'text', placeholder: '' },
      maxzoom: { label: 'maxzoom (opt)', kind: 'text', placeholder: '' },
      filter: { label: 'filter (opt)', kind: 'text', placeholder: '.population > 1000000' },
      pipe: {
        label: 'Utilities (one pipeline per line)',
        kind: 'textarea',
        placeholder: 'fill-blue-400 stroke-white stroke-2 opacity-80',
      },
    },
    defaults: {
      name: 'districts',
      sourceLayer: '',
      minzoom: '',
      maxzoom: '',
      filter: '',
      pipe: 'fill-blue-400 stroke-white stroke-2 opacity-80',
    },
  },
  background: {
    title: 'Background',
    accent: '#64748b',
    blurb: 'Bottom-most clear colour.',
    fields: { fill: { label: 'fill', kind: 'text', placeholder: 'sky-900' } },
    defaults: { fill: 'sky-900' },
  },
}

function buildConstructSpec(keyword: string, def: ConstructDef): NodeSpec {
  const p = PRESENTATION[keyword]
  if (!p) throw new Error(`@xgis/blueprint: no presentation overlay for construct "${keyword}"`)
  const fields: FieldSpec[] = def.properties.map((prop) => {
    const ui = p.fields[prop.key]
    if (!ui) throw new Error(`@xgis/blueprint: overlay missing field "${prop.key}" for "${keyword}"`)
    return {
      key: prop.key,
      label: ui.label,
      kind: ui.kind,
      ...(prop.options ? { options: [...prop.options] } : {}),
      ...(ui.placeholder !== undefined ? { placeholder: ui.placeholder } : {}),
    }
  })
  const inputs: PinSpec[] = (def.refs ?? []).map((r) => ({
    id: r.pin,
    label: r.pin,
    type: r.refType,
    ...(r.multi ? { multi: true } : {}),
    ...(r.required ? { required: true } : {}),
  }))
  const outputs: PinSpec[] = def.produces
    ? [{ id: 'out', label: p.outLabel ?? keyword, type: def.produces }]
    : []
  return {
    type: keyword as NodeType,
    title: p.title,
    accent: p.accent,
    blurb: p.blurb,
    category: def.category,
    fields,
    inputs,
    outputs,
  }
}

/** Editor-only nodes — not X-GIS language constructs. */
const EDITOR_NODES: Record<'map' | 'reroute', NodeSpec> = {
  map: {
    type: 'map',
    title: 'Map',
    accent: '#2997ff',
    blurb: 'Output sink. Layer order top→bottom = draw order.',
    category: 'Output',
    fields: [],
    inputs: [{ id: 'layers', label: 'layers', type: 'layer', multi: true }],
    outputs: [],
    singleton: true,
  },
  reroute: {
    type: 'reroute',
    title: 'Reroute',
    accent: '#8a8f98',
    blurb: 'A wire knot for tidy routing — passes any type through.',
    category: 'Util',
    fields: [],
    inputs: [{ id: 'in', label: '', type: 'any' }],
    outputs: [{ id: 'out', label: '', type: 'any' }],
    passthrough: true,
  },
}

export const NODE_SPECS: Record<NodeType, NodeSpec> = (() => {
  const out: Partial<Record<NodeType, NodeSpec>> = {}
  for (const [keyword, def] of Object.entries(LANGUAGE_SCHEMA)) {
    out[keyword as NodeType] = buildConstructSpec(keyword, def)
  }
  out.map = EDITOR_NODES.map
  out.reroute = EDITOR_NODES.reroute
  return out as Record<NodeType, NodeSpec>
})()

export interface BPNode {
  id: string
  type: NodeType
  x: number
  y: number
  data: Record<string, string>
}

export interface BPEdge {
  id: string
  from: { node: string; pin: string }
  to: { node: string; pin: string }
}

export interface BPGraph {
  nodes: BPNode[]
  edges: BPEdge[]
  frames?: BPFrame[]
}

let _id = 0
export function uid(prefix: string): string {
  _id += 1
  return `${prefix}_${Date.now().toString(36)}_${_id}`
}

/** Sensible defaults so a freshly-dropped node emits something
 *  meaningful instead of an empty husk. */
export function defaultData(type: NodeType): Record<string, string> {
  if (type === 'map' || type === 'reroute') return {}
  const p = PRESENTATION[type]
  return p ? { ...p.defaults } : {}
}

/** A friendly first-run graph: Source → Layer → Map, matching the
 *  README hero so the source pane is non-empty on first paint. */
export function starterGraph(): BPGraph {
  const src: BPNode = {
    id: uid('n'),
    type: 'source',
    x: 60,
    y: 120,
    data: { name: 'land', type: 'geojson', url: 'land.geojson', layers: '' },
  }
  const lay: BPNode = {
    id: uid('n'),
    type: 'layer',
    x: 440,
    y: 80,
    data: {
      name: 'continents',
      sourceLayer: '',
      minzoom: '',
      maxzoom: '',
      filter: '',
      pipe: 'fill-blue-400 stroke-white stroke-2 opacity-80',
    },
  }
  const map: BPNode = { id: uid('n'), type: 'map', x: 860, y: 140, data: {} }
  return {
    nodes: [src, lay, map],
    edges: [
      { id: uid('e'), from: { node: src.id, pin: 'out' }, to: { node: lay.id, pin: 'source' } },
      { id: uid('e'), from: { node: lay.id, pin: 'out' }, to: { node: map.id, pin: 'layers' } },
    ],
  }
}
