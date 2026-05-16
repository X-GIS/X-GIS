// Declarative schema of the X-GIS top-level constructs. This is the
// single source of truth that downstream tooling (the @xgis/blueprint
// visual editor) derives its node catalogue from, instead of keeping a
// parallel hand-maintained table that silently drifts from the grammar.
//
// Scope: the 8 real language constructs only. Presentation (titles,
// colours, which field renders as a textarea) and editor-only nodes
// (the `map` output sink, `reroute` knots) are NOT language facts and
// live in the editor, not here.
//
// A conformance test (language.test.ts) parses a minimal block per
// construct through the real Lexer + Parser so this declaration cannot
// drift from what the compiler actually accepts.

export type SchemaValueKind =
  | 'identifier' // block name (the `foo` in `source foo { … }`)
  | 'string' // quoted/url-ish text
  | 'number' // numeric scalar
  | 'enum' // one of `options`
  | 'expr' // an X-GIS expression
  | 'pipe' // one or more `| utility …` lines

/** Cross-block reference data-types — these become typed editor pins. */
export type SchemaPinType = 'source' | 'style' | 'preset' | 'symbol' | 'layer'

export interface SchemaProperty {
  /** Stable key: also the editor data key and the emitted property
   *  name. Treated as a contract — never rename. */
  key: string
  valueKind: SchemaValueKind
  options?: readonly string[]
  required?: boolean
}

/** A reference from this construct to another block (e.g. a layer's
 *  `source:`), surfaced as an input pin in the editor. */
export interface SchemaRef {
  /** Stable pin id consumed by codegen's wire resolver. */
  pin: string
  refType: SchemaPinType
  multi?: boolean
  required?: boolean
}

export interface ConstructDef {
  /** Lexer keyword that opens the block. */
  keyword: string
  /** Matches a `parser/ast.ts` Statement `kind`. */
  astKind: string
  /** Catalogue grouping for a Blender/Unreal-style node palette. */
  category: 'Data' | 'Style' | 'Render' | 'Logic'
  /** Output pin data-type, if this construct can be referenced. */
  produces?: SchemaPinType
  properties: SchemaProperty[]
  refs?: SchemaRef[]
}

/** Accepted `source { type: … }` values. */
export const SOURCE_TYPES = [
  'geojson',
  'pmtiles',
  'raster',
  'tilejson',
  'vector',
  'raster-dem',
  'binary',
] as const

/** Accepted `symbol { anchor: … }` values. */
export const ANCHORS = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const

export const LANGUAGE_SCHEMA: Record<string, ConstructDef> = {
  import: {
    keyword: 'import',
    astKind: 'ImportStatement',
    category: 'Data',
    properties: [
      { key: 'mode', valueKind: 'enum', options: ['splice', 'named'] },
      { key: 'names', valueKind: 'string' },
      { key: 'path', valueKind: 'string', required: true },
    ],
  },

  source: {
    keyword: 'source',
    astKind: 'SourceStatement',
    category: 'Data',
    produces: 'source',
    properties: [
      { key: 'name', valueKind: 'identifier', required: true },
      { key: 'type', valueKind: 'enum', options: SOURCE_TYPES, required: true },
      { key: 'url', valueKind: 'string' },
      { key: 'layers', valueKind: 'string' },
    ],
  },

  symbol: {
    keyword: 'symbol',
    astKind: 'SymbolStatement',
    category: 'Style',
    produces: 'symbol',
    properties: [
      { key: 'name', valueKind: 'identifier', required: true },
      { key: 'path', valueKind: 'string' },
      { key: 'anchor', valueKind: 'enum', options: ANCHORS },
    ],
  },

  style: {
    keyword: 'style',
    astKind: 'StyleStatement',
    category: 'Style',
    produces: 'style',
    properties: [
      { key: 'name', valueKind: 'identifier', required: true },
      { key: 'fill', valueKind: 'string' },
      { key: 'stroke', valueKind: 'string' },
      // Editor/data key stays `strokeWidth`; codegen emits the
      // `stroke-width` token. Do not rename — codegen contract.
      { key: 'strokeWidth', valueKind: 'number' },
      { key: 'opacity', valueKind: 'number' },
    ],
  },

  preset: {
    keyword: 'preset',
    astKind: 'PresetStatement',
    category: 'Style',
    produces: 'preset',
    properties: [
      { key: 'name', valueKind: 'identifier', required: true },
      { key: 'pipe', valueKind: 'pipe' },
    ],
  },

  fn: {
    keyword: 'fn',
    astKind: 'FnStatement',
    category: 'Logic',
    properties: [
      { key: 'name', valueKind: 'identifier', required: true },
      { key: 'params', valueKind: 'string' },
      { key: 'ret', valueKind: 'string' },
      { key: 'body', valueKind: 'expr' },
    ],
  },

  layer: {
    keyword: 'layer',
    astKind: 'LayerStatement',
    category: 'Render',
    produces: 'layer',
    properties: [
      { key: 'name', valueKind: 'identifier', required: true },
      { key: 'sourceLayer', valueKind: 'string' },
      { key: 'minzoom', valueKind: 'number' },
      { key: 'maxzoom', valueKind: 'number' },
      { key: 'filter', valueKind: 'expr' },
      { key: 'pipe', valueKind: 'pipe' },
    ],
    refs: [
      { pin: 'source', refType: 'source', required: true },
      { pin: 'style', refType: 'style' },
      { pin: 'apply', refType: 'preset', multi: true },
      { pin: 'symbol', refType: 'symbol' },
    ],
  },

  background: {
    keyword: 'background',
    astKind: 'BackgroundStatement',
    category: 'Render',
    properties: [{ key: 'fill', valueKind: 'string' }],
  },
}
