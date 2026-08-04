// ═══ AST Node Types for X-GIS ═══

export type Program = {
  kind: 'Program'
  body: Statement[]
}

export type Statement =
  | SourceStatement
  | LayerStatement
  | BackgroundStatement
  | PresetStatement
  | ImportStatement
  | SymbolStatement
  | KeyframesStatement
  | FnStatement
  | StructStatement

// ═══ Expressions ═══

export type Expr =
  | NumberLiteral
  | StringLiteral
  | ColorLiteral
  | BoolLiteral
  | Identifier
  | FieldAccess
  | FnCall
  | BinaryExpr
  | ArrayLiteral
  | ObjectLiteral
  | ArrayAccess
  | ConditionalExpr
  | UnaryExpr
  | MatchBlock

export type NumberLiteral = {
  kind: 'NumberLiteral'
  value: number
  unit: string | null // 'px', 'm', 'km', 'deg', etc.
}

export type StringLiteral = {
  kind: 'StringLiteral'
  value: string
}

export type ColorLiteral = {
  kind: 'ColorLiteral'
  value: string // '#ff0000'
}

export type BoolLiteral = {
  kind: 'BoolLiteral'
  value: boolean
}

export type Identifier = {
  kind: 'Identifier'
  name: string
}

// .field access (data binding)
export type FieldAccess = {
  kind: 'FieldAccess'
  object: Expr | null // null means implicit current data (e.g., .speed)
  field: string
}

// load("file"), clamp(4, 24), etc.
export type FnCall = {
  kind: 'FnCall'
  callee: Expr
  args: Expr[]
  matchBlock?: MatchBlock // match(field) { "val" -> color, ... }
}

// a + b, a > b, etc.
export type BinaryExpr = {
  kind: 'BinaryExpr'
  op: string
  left: Expr
  right: Expr
}

// -x, !x
export type UnaryExpr = {
  kind: 'UnaryExpr'
  op: string
  operand: Expr
}

// { hostile: #ff0000, friendly: #00ff00, _: #808080 }
export type MatchBlock = {
  kind: 'MatchBlock'
  arms: MatchArm[]
}

export type MatchArm = {
  // A single label. `string | number` preserves the literal's JS type so the
  // evaluator can apply Mapbox `match` type-strict semantics — a numeric label
  // matches only a numeric input, never its stringified form (`2` ≠ "2"). The
  // catch-all default arm is the string '_'. Comma-separated pattern lists
  // (`"a", "b" -> v`) are desugared by the parser into one arm per label.
  pattern: string | number
  value: Expr
}

export type ArrayLiteral = {
  kind: 'ArrayLiteral'
  elements: Expr[]
}

// { "type": "FeatureCollection", "features": [...] } — value-position
// object literal (used by `source x { data: {...} }` to embed inline
// GeoJSON). Keys may be string- or identifier-literal; values are any
// Expr (lower.ts restricts to JSON-literal subtrees for `data:`).
export type ObjectLiteral = {
  kind: 'ObjectLiteral'
  properties: { key: string; value: Expr }[]
}

export type ArrayAccess = {
  kind: 'ArrayAccess'
  array: Expr
  index: Expr
}

// condition ? thenExpr : elseExpr
export type ConditionalExpr = {
  kind: 'ConditionalExpr'
  condition: Expr
  thenExpr: Expr
  elseExpr: Expr
}

// ═══ New syntax: source/layer/utility (DESIGN.md v3) ═══

// source world { type: geojson, url: "./data/countries.geojson" }
export type SourceStatement = {
  kind: 'SourceStatement'
  name: string
  properties: BlockProperty[]
  line: number
}

// layer districts { source: neighborhoods, | fill-blue-400 stroke-white stroke-2 }
export type LayerStatement = {
  kind: 'LayerStatement'
  name: string
  properties: BlockProperty[]
  /** Shader stage blocks authored on this layer (#1538). Absent on every
   *  layer that does not use the escape hatch. */
  stages?: StageBlock[]
  utilities: UtilityLine[]
  styleProperties: StyleProperty[] // CSS-like properties: fill: stone-800
  line: number
}

// background { fill: sky-900 } — Mapbox-style canvas clear color.
// Renders as the bottom-most layer (replaces the hardcoded canvas
// clearValue). Style accepts the same fill utilities + properties
// as a regular layer, but only the resolved fill color is consumed
// (no stroke / no source / no per-feature style).
export type BackgroundStatement = {
  kind: 'BackgroundStatement'
  utilities: UtilityLine[]
  styleProperties: StyleProperty[]
  line: number
}

// Generic key: value property used in source/layer blocks
export type BlockProperty = {
  kind: 'BlockProperty'
  name: string
  value: Expr
  line: number
}

// A single | line: | fill-red-500 stroke-white stroke-2 opacity-80
export type UtilityLine = {
  kind: 'UtilityLine'
  items: UtilityItem[]
  line: number
}

// preset military_track { | symbol-arrow stroke-black stroke-1 | ... }
// A preset may also carry block properties (e.g. coverage paint `ramp:`/`range:`),
// so an importable portrayal preset — `preset s111_currents { ramp: "s111-speed"; range: [0, 13] }`
// — applies via `style:` to a layer just like its utility lines (#1272 E-②).
export type PresetStatement = {
  kind: 'PresetStatement'
  name: string
  /** Declared parameter names from `preset name(a, b) { … }` (#1536).
   *  Absent on zero-arg presets — the pre-params grammar unchanged. */
  params?: string[]
  utilities: UtilityLine[]
  properties: BlockProperty[]
  line: number
}

// import { name1, name2 } from "file.xgs"        — cherry-pick
// import "file.xgs"                                — splice
// import "style.json" keep (transportation, place) — splice, layers filtered
// import * as ns from "file.xgs"                   — namespaced splice (`namespace` set)
export type ImportStatement = {
  kind: 'ImportStatement'
  names: string[]
  path: string
  line: number
  /** Set by `import * as ns from "..."`. When present the imported module's
   *  block-level definitions (source/layer/preset/keyframes) are spliced under
   *  the `ns.` prefix and their intra-module references rewritten to match. */
  namespace?: string
  /** Set by the `keep (a, b, ...)` clause on a splice import. Filters the
   *  imported style's LAYERS to those whose `source-layer` is listed — so a
   *  Mapbox/OFM base style can contribute only some of its layers (e.g. just
   *  `transportation` + `place`) with their ORIGINAL paint/filters/zoom, while
   *  every non-layer statement (sources, background) still splices. Only the
   *  directly-named style is filtered; nested imports are unaffected. */
  keepSourceLayers?: string[]
}

// symbol arrow { path "M 0 -1 L -0.4 0.3 Z", anchor: center }
export type SymbolStatement = {
  kind: 'SymbolStatement'
  name: string
  elements: SymbolElement[]
  line: number
}

export type SymbolElement =
  | { kind: 'path'; data: string }
  | { kind: 'rect'; props: Record<string, number> }
  | { kind: 'circle'; props: Record<string, number> }
  | { kind: 'anchor'; value: string }

// CSS-like property: fill: stone-800, stroke-width: 1, opacity: 0.8
// Used inline inside `layer` / `background` blocks (`fill: stone-800`).
export type StyleProperty = {
  kind: 'StyleProperty'
  name: string // e.g., 'fill', 'stroke', 'stroke-width', 'opacity'
  value: string // e.g., 'stone-800', '#ff0000', '1', '0.8'
  line: number
}

// A single utility item, e.g., z8:fill-red-500 or size-[speed/50]
export type UtilityItem = {
  kind: 'UtilityItem'
  modifier: string | null // e.g., "z8", "friendly", "hover" (before the colon)
  name: string // e.g., "fill-red-500", "stroke-2", "opacity-80"
  binding: Expr | null // e.g., the expression inside [...] for data binding
  bindingUnit?: string | null // e.g., "km" in size-[expr]km
  /** Call-form arguments for `apply-<preset>(…)` items (#1536).
   *  Absent on every other utility item. */
  args?: Expr[]
}

// fn halo(width, base) { return clamp(width * 1.5 + base, 1, 24) }
// User-defined function (#1535 — reintroduced after the #1072 prune).
// v1 is expression-bodied: the body is exactly one `return <expr>`;
// calls are inlined at lower time (ir/fn-inline.ts), so the evaluator,
// classifier, and WGSL codegen never see a user-fn call.
export type FnStatement = {
  kind: 'FnStatement'
  name: string
  params: string[]
  body: Expr
  line: number
}

// @color { return vec4(.r, 0.5, 0, 1) }  —  a shader stage block (#1538).
// The Level-4 escape hatch: the body is authored in the .xgis expression
// language and lowers to shader-dsl IR (never WGSL text), landing in the
// SAME variant colour slot a data-driven paint already fills. Expression-
// bodied like `fn` (§2.10): exactly one `return <expr>`, typed vec4.
export type StageBlock = {
  /** Which fragment colour the block authors. `@position` (vertex
   *  displacement) is NOT here: the variant composer has no vertex-side
   *  slot today, so it is deferred rather than faked. */
  stage: 'color' | 'stroke'
  body: Expr
  line: number
}

// struct Track { speed: f32, heading: f32, name: string }
// A source field schema (#1537 — reintroduced after the #1072 prune).
// Attached to a source via `schema: Track`; makes `.field` access on that
// source's layers checked instead of silently null on a typo.
export type StructStatement = {
  kind: 'StructStatement'
  name: string
  fields: StructField[]
  line: number
}

/** Declared field types. Deliberately the three the data model already
 *  distinguishes (`spec/oracle` value kinds); v1 uses them for NAME
 *  checking — type-directed classification is a later step. */
export type StructFieldType = 'f32' | 'string' | 'bool'

export type StructField = { name: string; type: StructFieldType }

// keyframes pulse { 0%: opacity-100  50%: opacity-30  100%: opacity-100 }
export type KeyframesStatement = {
  kind: 'KeyframesStatement'
  name: string // e.g., "pulse"
  frames: Keyframe[] // sorted by percent after parsing
  line: number
}

// A single keyframe: { percent: 50, utilities: [UtilityItem('opacity-30')] }
export type Keyframe = {
  percent: number // 0..100 (from=0, to=100)
  utilities: UtilityItem[]
  line: number
}
