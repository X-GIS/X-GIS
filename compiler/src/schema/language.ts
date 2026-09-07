// Declarative schema of the X-GIS top-level constructs. This is the
// single source of truth that downstream tooling (the @xgis/blueprint
// visual editor) derives its node catalogue from, instead of keeping a
// parallel hand-maintained table that silently drifts from the grammar.
//
// Scope: the real language constructs only. Presentation (titles,
// colours, which field renders as a textarea) and editor-only nodes
// (the `map` output sink, `reroute` knots) are NOT language facts and
// live in the editor, not here.
//
// A conformance test (language.test.ts) parses a minimal block per
// construct through the real Lexer + Parser so this declaration cannot
// drift from what the compiler actually accepts.

import { SYMBOL_ANCHORS } from '../ir/symbol-elements'

export type SchemaValueKind =
  | 'identifier' // block name (the `foo` in `source foo { … }`)
  | 'string' // quoted/url-ish text
  | 'number' // numeric scalar
  | 'enum' // one of `options`
  | 'expr' // an X-GIS expression
  | 'pipe' // one or more `| utility …` lines
  | 'params' // comma-separated declared parameter names (`preset p(a, b)`, #1536)
  | 'fields' // comma-separated `name: type` field declarations (`struct T { … }`, #1537)

/** Cross-block reference data-types — these become typed editor pins. */
export type SchemaPinType = 'source' | 'preset' | 'symbol' | 'layer'

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
  // S-100 gridded coverage (HDF5, read in place) — a built-in source (#1158 GAP-1,
  // re-platformed by ADR-0010). Adding it
  // here auto-propagates to @xgis/map's BUILTIN_SOURCE_TYPES (derived from this
  // list), so the dispatch handles it natively rather than routing to the custom-
  // loader registry. NOT a spec-coverage row: the Mapbox converter's spec-coverage
  // table is a separate authority; the drift gate binds spec-coverage↔RUNTIME only.
  'coverage',
  // `hdf5` / `h5` are FORMAT-NAMED ALIASES of the coverage family — the exact mirror
  // of `pmtiles`/`tilejson` under `vector`: a render family carries one ROLE name
  // (`coverage`, the ISO 19123 / S-100 term) plus container-name aliases, and the
  // reader is still chosen from the URL extension (detectCoverageFormat). The lowering
  // canonicalises hdf5/h5 → coverage (lower.ts lowerSource), so the IR, dead-layer-elim,
  // and runtime only ever see `coverage`; these entries exist so the bare identifier
  // parses and the editor/palette advertises the spelling. GRIB2/NetCDF/COG join here.
  'hdf5',
  'h5',
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
      // SYMBOL_ANCHORS is the single authority on which anchors exist — the
      // lowering gates on it (`isSymbolAnchor`) and the grammar agrees with it.
      // Referenced, never re-listed: the schema used to carry its own 9-value
      // copy, and the four corner values in it were hard PARSE errors, so an
      // editor driven by this table emitted uncompilable `.xgis` (#2548).
      // NOTE the Mapbox converter's nine-valued VALID_ANCHORS
      // (convert/layers-helpers.ts) stays as it is: `label-anchor-top-left` is a
      // utility NAME, a different grammar position where the hyphen is a segment
      // separator, so nine is correct there and is NOT the same drift.
      { key: 'anchor', valueKind: 'enum', options: SYMBOL_ANCHORS },
    ],
  },

  // The single full-surface reusable-style construct (the former
  // `style` block merged in): a named bundle of any utility lines,
  // referenced by a layer via either `apply-<name>` or `style:` —
  // optionally parameterized (`preset glow(color, radius)`, #1536) with
  // call-form references (`style: glow(#f59e0b, 4)`, `apply-glow(…)`).
  preset: {
    keyword: 'preset',
    astKind: 'PresetStatement',
    category: 'Style',
    produces: 'preset',
    properties: [
      { key: 'name', valueKind: 'identifier', required: true },
      { key: 'params', valueKind: 'params' },
      { key: 'pipe', valueKind: 'pipe' },
    ],
  },

  // User-defined function (#1535 — reintroduced end-to-end after the
  // #1072 prune): expression-bodied, inlined at lower time so a GPU-safe
  // body rides the per-feature-gpu path. Referenced by NAME inside
  // expressions (no editor pin type — calls are not wires).
  fn: {
    keyword: 'fn',
    astKind: 'FnStatement',
    category: 'Logic',
    properties: [
      { key: 'name', valueKind: 'identifier', required: true },
      { key: 'params', valueKind: 'params' },
      { key: 'body', valueKind: 'expr', required: true },
    ],
  },

  // A source field schema (#1537): attached via `source x { schema: T }`,
  // it turns `.field` reads on that source's layers into checked access.
  // Referenced by NAME from a source property — not a wired pin.
  struct: {
    keyword: 'struct',
    astKind: 'StructStatement',
    category: 'Data',
    properties: [
      { key: 'name', valueKind: 'identifier', required: true },
      { key: 'fields', valueKind: 'fields', required: true },
    ],
  },

  // #1539 — a host-settable parameter. `default` is a literal of the declared
  // type (checked at parse time), so it is an `expr` pin like any other value.
  input: {
    keyword: 'input',
    astKind: 'InputStatement',
    category: 'Data',
    properties: [
      { key: 'name', valueKind: 'identifier', required: true },
      { key: 'type', valueKind: 'enum', options: ['f32', 'color'], required: true },
      { key: 'default', valueKind: 'expr', required: true },
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
      // #1158 INC-D — `coverage` LAYER paint: `ramp` names a colour-ramp LUT, `range`
      // is a `[lo, hi]` value window. The graduation the INC-A SOURCE note promised:
      // styling (value→colour) is a paint/LAYER concern (the Mapbox raster-color /
      // raster-color-range analogue), so a `coverage` source is data-only and the
      // layer that draws it carries the palette + window.
      { key: 'ramp', valueKind: 'string' },
      { key: 'range', valueKind: 'expr' },
    ],
    refs: [
      { pin: 'source', refType: 'source', required: true },
      // `style:` and `apply-` both reference a preset (the merged
      // full-surface construct); `style:` is the single-preset base,
      // `apply-` the multi-preset overlay.
      { pin: 'style', refType: 'preset' },
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
