// Node/edge/graph model + per-node-type specs for the visual
// blueprint editor. Each node type maps 1:1 to an X-GIS top-level
// construct (source / layer / preset / fn / symbol / import / style /
// background) plus a terminal `map` sink that fixes draw order.
//
// The specs here are the single source of truth the editor renders
// from and the codegen walks — keep them faithful to the compiler
// grammar (see SPEC / parser.ts).

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

export interface NodeSpec {
  type: NodeType
  title: string
  accent: string
  blurb: string
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

const SOURCE_TYPES = [
  'geojson',
  'pmtiles',
  'raster',
  'tilejson',
  'vector',
  'raster-dem',
  'binary',
]

const ANCHORS = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
]

export const NODE_SPECS: Record<NodeType, NodeSpec> = {
  import: {
    type: 'import',
    title: 'Import',
    accent: '#94a3b8',
    blurb: 'Pull symbols/presets from a file, or splice an entire style.',
    fields: [
      { key: 'mode', label: 'Mode', kind: 'select', options: ['splice', 'named'] },
      {
        key: 'names',
        label: 'Names (named only)',
        kind: 'text',
        placeholder: 'railway_tie, cliff_tooth',
      },
      {
        key: 'path',
        label: 'Path / URL',
        kind: 'text',
        placeholder: 'https://tiles.openfreemap.org/styles/bright',
      },
    ],
    inputs: [],
    outputs: [],
  },

  source: {
    type: 'source',
    title: 'Source',
    accent: PIN_COLOR.source,
    blurb: 'A data source feeding one or more layers.',
    fields: [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'world' },
      { key: 'type', label: 'Type', kind: 'select', options: SOURCE_TYPES },
      {
        key: 'url',
        label: 'URL',
        kind: 'text',
        placeholder: './data/countries.geojson',
      },
      {
        key: 'layers',
        label: 'MVT layers (opt, comma)',
        kind: 'text',
        placeholder: 'water, roads',
      },
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'source', type: 'source' }],
  },

  symbol: {
    type: 'symbol',
    title: 'Symbol',
    accent: PIN_COLOR.symbol,
    blurb: 'A vector glyph referenced by symbol-/shape- utilities.',
    fields: [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'arrow' },
      {
        key: 'path',
        label: 'SVG path',
        kind: 'text',
        placeholder: 'M 0 -1 L -0.4 0.3 L 0.4 0.3 Z',
      },
      { key: 'anchor', label: 'Anchor', kind: 'select', options: ANCHORS },
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'symbol', type: 'symbol' }],
  },

  style: {
    type: 'style',
    title: 'Style',
    accent: PIN_COLOR.style,
    blurb: 'A named style block consumed via a layer’s style: field.',
    fields: [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'dark_land' },
      { key: 'fill', label: 'fill', kind: 'text', placeholder: 'stone-800' },
      { key: 'stroke', label: 'stroke', kind: 'text', placeholder: 'slate-600' },
      { key: 'strokeWidth', label: 'stroke-width', kind: 'text', placeholder: '1' },
      { key: 'opacity', label: 'opacity', kind: 'text', placeholder: '0.8' },
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'style', type: 'style' }],
  },

  preset: {
    type: 'preset',
    title: 'Preset',
    accent: PIN_COLOR.preset,
    blurb: 'A reusable utility combo applied via apply-<name>.',
    fields: [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'alert_track' },
      {
        key: 'pipe',
        label: 'Utilities (one pipeline per line)',
        kind: 'textarea',
        placeholder: 'symbol-arrow fill-red-500 glow-8\nanimate-pulse-1s',
      },
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'preset', type: 'preset' }],
  },

  fn: {
    type: 'fn',
    title: 'Function',
    accent: '#60a5fa',
    blurb: 'A user function usable inside [bracket] expressions.',
    fields: [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'threat_size' },
      { key: 'params', label: 'Params', kind: 'text', placeholder: 'level: f32' },
      { key: 'ret', label: 'Return type', kind: 'text', placeholder: 'f32' },
      {
        key: 'body',
        label: 'Body',
        kind: 'textarea',
        placeholder: 'clamp(level * 4, 8, 32)',
      },
    ],
    inputs: [],
    outputs: [],
  },

  layer: {
    type: 'layer',
    title: 'Layer',
    accent: PIN_COLOR.layer,
    blurb: 'A rendered layer: a source styled by a utility pipeline.',
    fields: [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'districts' },
      {
        key: 'sourceLayer',
        label: 'sourceLayer (opt)',
        kind: 'text',
        placeholder: 'water',
      },
      { key: 'minzoom', label: 'minzoom (opt)', kind: 'text', placeholder: '' },
      { key: 'maxzoom', label: 'maxzoom (opt)', kind: 'text', placeholder: '' },
      {
        key: 'filter',
        label: 'filter (opt)',
        kind: 'text',
        placeholder: '.population > 1000000',
      },
      {
        key: 'pipe',
        label: 'Utilities (one pipeline per line)',
        kind: 'textarea',
        placeholder: 'fill-blue-400 stroke-white stroke-2 opacity-80',
      },
    ],
    inputs: [
      { id: 'source', label: 'source', type: 'source', required: true },
      { id: 'style', label: 'style', type: 'style' },
      { id: 'apply', label: 'apply', type: 'preset', multi: true },
      { id: 'symbol', label: 'symbol', type: 'symbol' },
    ],
    outputs: [{ id: 'out', label: 'layer', type: 'layer' }],
  },

  background: {
    type: 'background',
    title: 'Background',
    accent: '#64748b',
    blurb: 'Bottom-most clear colour.',
    fields: [{ key: 'fill', label: 'fill', kind: 'text', placeholder: 'sky-900' }],
    inputs: [],
    outputs: [],
  },

  map: {
    type: 'map',
    title: 'Map',
    accent: '#2997ff',
    blurb: 'Output sink. Layer order top→bottom = draw order.',
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
    fields: [],
    inputs: [{ id: 'in', label: '', type: 'any' }],
    outputs: [{ id: 'out', label: '', type: 'any' }],
    passthrough: true,
  },
}

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
  switch (type) {
    case 'import':
      return { mode: 'splice', names: '', path: '' }
    case 'source':
      return { name: 'world', type: 'geojson', url: './data/countries.geojson', layers: '' }
    case 'symbol':
      return { name: 'arrow', path: 'M 0 -1 L -0.4 0.3 L 0.4 0.3 Z', anchor: 'center' }
    case 'style':
      return { name: 'land', fill: 'stone-800', stroke: '', strokeWidth: '', opacity: '' }
    case 'preset':
      return { name: 'alert_track', pipe: 'fill-red-500 stroke-white stroke-2' }
    case 'fn':
      return { name: 'threat_size', params: 'level: f32', ret: 'f32', body: 'clamp(level * 4, 8, 32)' }
    case 'layer':
      return {
        name: 'districts',
        sourceLayer: '',
        minzoom: '',
        maxzoom: '',
        filter: '',
        pipe: 'fill-blue-400 stroke-white stroke-2 opacity-80',
      }
    case 'background':
      return { fill: 'sky-900' }
    case 'map':
      return {}
    case 'reroute':
      return {}
  }
}

/** A friendly first-run graph: Source → Layer → Map, matching the
 *  README hero so the source pane is non-empty on first paint. */
export function starterGraph(): BPGraph {
  const src: BPNode = {
    id: uid('n'),
    type: 'source',
    x: 60,
    y: 120,
    data: { name: 'world', type: 'geojson', url: './data/countries.geojson', layers: '' },
  }
  const lay: BPNode = {
    id: uid('n'),
    type: 'layer',
    x: 440,
    y: 80,
    data: {
      name: 'countries',
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
