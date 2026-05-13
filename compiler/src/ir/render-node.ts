// ═══ X-GIS Intermediate Representation ═══
// Sits between AST (syntax) and runtime (GPU commands).
// Designed to be extensible for Phase 1 features (zoom interpolation, data-driven, conditionals).

/**
 * A complete IR scene — the output of the lowering pass.
 */
export interface Scene {
  sources: SourceDef[]
  renderNodes: RenderNode[]
  symbols: SymbolDef[]
  /** Compiler diagnostics — surface in /convert page + runtime
   *  console. Optional for back-compat; consumers should treat
   *  `undefined` as empty array. */
  diagnostics?: Diagnostic[]
}

/** Compiler diagnostic — one record per "this is suspicious / wrong /
 *  silently broken" finding. Severity tiers (no errors at this level —
 *  the lower pass never fails the build because of a diagnostic):
 *    - 'warn'   — definitely wrong, will produce wrong output. Show
 *                 prominently. Examples: deprecated `z<N>:` modifier,
 *                 unknown utility name (lower can't apply), etc.
 *    - 'info'   — heads-up that may be intentional. Example: dropped
 *                 properties from converted Mapbox styles. */
export interface Diagnostic {
  severity: 'warn' | 'info'
  /** Human-readable message. Lead with what's wrong, then what to do. */
  message: string
  /** Optional code so consumers can filter/categorise.
   *  Format: 'X-GIS<NNNN>'. */
  code?: string
  /** Optional source line (1-based) where the issue was detected. */
  line?: number
}

/** A user-defined shape symbol with SVG path data. */
export interface SymbolDef {
  name: string
  paths: string[]
}

/**
 * A data source definition.
 */
export interface SourceDef {
  name: string
  type: string      // 'geojson', 'vector', 'raster', 'raster-dem', 'binary'
  url: string
  /** Optional MVT layer-name subset (PMTiles only). When set, the
   *  decoder filters features by `_layer` before decompose+compile.
   *  Lets multiple xgis sources point at the same archive with
   *  different MVT layer slices for layered styling. */
  layers?: string[]
}

/**
 * A single renderable unit — one layer referencing one source.
 */
export interface RenderNode {
  name: string
  sourceRef: string  // references SourceDef.name
  /** Optional MVT layer slice within the referenced source. When set,
   *  the runtime draws only this layer's geometry from each tile —
   *  Mapbox/MapLibre's `source-layer` semantics (lexer prefers
   *  camelCase `sourceLayer`). */
  sourceLayer?: string
  zOrder: number
  /** Mapbox `layer.minzoom` — layer is hidden below this zoom level.
   *  Camera zoom is fractional; we apply `camera.zoom >= minzoom`
   *  (inclusive lower bound, matching Mapbox spec). Without this gate
   *  every sub-layer of a multi-layer style (label_city minz=3,
   *  label_state minz=5, all POI shows minz=15+) renders at z=0
   *  simultaneously, piling every feature into the same viewport. */
  minzoom?: number
  /** Mapbox `layer.maxzoom` — layer is hidden at or above this zoom
   *  level. Camera zoom is fractional; we apply `camera.zoom <
   *  maxzoom` (exclusive upper bound, matching Mapbox spec).
   *  Critical for country labels (maxzoom=9) so they don't paint over
   *  city detail at z=10+ where the city label takes over. */
  maxzoom?: number
  fill: ColorValue
  stroke: StrokeValue
  opacity: OpacityValue
  size: SizeValue
  /** 3D extrusion height. Lifts polygon roof faces to z=value (metres)
   *  and emits side walls. `none` = flat (default). `constant` = every
   *  feature gets the same height. `feature` = look up a per-feature
   *  property (e.g. `extrude: .height` → ExtrudeValue with field
   *  'height'); the runtime asks the MVT decoder to preserve that
   *  field at decode time. */
  extrude: ExtrudeValue
  /** 3D extrusion base — the z value of the BOTTOM of the side walls
   *  (default 0, ground). Mapbox `fill-extrusion-base` semantic:
   *  combined with `extrude` (= top) it carves out a "min_height"
   *  for buildings whose footprint sits on a podium. Same value
   *  shapes as `extrude` (none / constant / feature). When `extrude`
   *  is `none`, this field is irrelevant and ignored. */
  extrudeBase: ExtrudeValue
  projection: string
  visible: boolean
  /** CSS-style pointer interactivity. 'none' tells the runtime to skip
   *  this layer's pickId write (writeMask:0 variant) so picks fall
   *  through to the layer beneath. 'auto' (default) is pickable. */
  pointerEvents: 'auto' | 'none'
  filter: DataExpr | null  // per-feature filter expression (e.g., .pop > 1000000)
  geometry: DataExpr | null  // procedural geometry expression (e.g., circle(.lon, .lat, .r))
  billboard: boolean         // true = faces camera (default), false = flat on ground
  shape: ShapeRef            // point shape (circle default, or named/user-defined)
  /** Billboard anchor: which edge of the quad sits on the projected point.
   *  `center` (default) puts the quad centered on the point; `bottom` makes
   *  the marker stand above the ground like a pin; `top` is its symmetric
   *  counterpart. Only affects billboard (non-flat) point markers. */
  anchor?: 'center' | 'bottom' | 'top'
  /** Layer-wide animation lifecycle metadata. Set when ANY property on
   *  this layer references a `keyframes` block. A single layer can only
   *  host one `animation-<name>` reference, so loop / easing / delayMs
   *  are shared across every animated property (fill, stroke, width,
   *  size, dash-offset). emit-commands reads from this field as the
   *  authoritative source of lifecycle metadata. */
  animationMeta?: { loop: boolean; easing: Easing; delayMs: number }
  /** Optional text label for the layer's features. When set, the
   *  point-renderer expands each feature into one quad per glyph
   *  (text content from `text.expr`, font + size from `text.font`
   *  and `text.size`). Mapbox `text-field` / `text-font` /
   *  `text-size` map here. Set via the `label-[<expr>]` utility OR
   *  the `label:` block property (added in Batch 1c).
   *
   *  Engine plumbing arrives in Batch 1c — this field is the
   *  contract that both the converter (Batch 1f) and the renderer
   *  agree on. Batch 1b only adds the field + lower.ts plumbing
   *  so Mapbox styles can carry text intent through compilation
   *  without throwing. Rendering stays no-op until 1c. */
  label?: LabelDef
}

// ─── Text template AST (Batch 1c) ─────────────────────────────────
//
// Label text is more than a single expression: GIS labels need
// inline format specifiers ("{lat:.4f}°N", "{coord:mgrs}", etc.).
// We encode this as a small AST: a sequence of literal fragments
// interleaved with `{<expr>:<spec>}` interpolations. The DSL
// surface is Mapbox-token-compatible — `"{name}"` parses to one
// `interp` part with no spec, exactly like the existing tokens —
// so styles relying on the legacy form keep working. Format
// dispatch (number / datetime / dms / mgrs / …) happens at
// per-feature text-resolve time (worker), not on the GPU.
//
// `kind: 'expr'` covers the simple legacy shape (a single bare
// expression, no surrounding literal text) without forcing every
// label through the template machinery. `kind: 'template'` is for
// anything richer.

/** Format spec for one interpolation. Subset of Python PEP 3101
 *  augmented with X-GIS GIS-specific types (`dms`/`mgrs`/...) and
 *  an explicit `locale` slot for deterministic ('C') output. */
export interface FormatSpec {
  /** Single fill character used with `align`. Default ' '. */
  fill?: string
  /** `<` left, `>` right, `^` center. Default depends on `type`
   *  (numbers right-align, strings left-align). */
  align?: '<' | '>' | '^'
  /** `+` always show sign, `-` only negatives (default), ` ` leave
   *  a leading space for positives. */
  sign?: '+' | '-' | ' '
  /** `#` flag — alternate form (e.g. always show decimal point). */
  alt?: boolean
  /** `0` flag — pad numeric output with leading zeros up to width. */
  zero?: boolean
  /** Minimum field width. */
  width?: number
  /** Thousands separator. `,` standard, `_` underscore. */
  grouping?: ',' | '_'
  /** Digits after decimal point (numbers) OR max length (strings). */
  precision?: number
  /** Format type. One of:
   *    Numbers: 'd' 'f' 'e' 'g' '%' (Python-compatible).
   *    Strings: 's' (or omitted).
   *    GIS:     'dms' 'dm' 'mgrs' 'utm' 'bearing'.
   *    Dates:   any string starting with '%' is treated as strftime. */
  type?: string
  /** BCP-47 locale tag. Special value 'C' forces deterministic
   *  POSIX-style output (no Intl), useful for audit / regression
   *  testing. Default: runtime's active locale. */
  locale?: string
}

export type TextPart =
  | { kind: 'literal'; value: string }
  | { kind: 'interp'; expr: DataExpr; spec?: FormatSpec }

export type TextValue =
  | { kind: 'expr'; expr: DataExpr }
  | { kind: 'template'; parts: TextPart[] }

// ─── LabelDef ─────────────────────────────────────────────────────

/** Per-layer text label spec. Engine plumbing arrives in
 *  Batch 1c-7. This interface is the contract that the converter,
 *  the lower pass, and the renderer all agree on; expanding it
 *  later means re-wiring all three so we capture the full
 *  Mapbox text-* / symbol-* knob set up front. Knobs marked
 *  `// 1d:` `// 1e:` etc. are typed but their semantics are
 *  defined by the batch that wires them — leaving them undefined
 *  in 1c is safe (renderer treats unset as default). */
export interface LabelDef {
  /** Text content. Most labels are a single field reference (the
   *  `kind: 'expr'` shape that Batch 1b emits) or a Mapbox-style
   *  template with embedded format specs (`kind: 'template'`). */
  text: TextValue

  // ── Typography ──
  /** Font stack — first available wins. Maps from Mapbox
   *  `text-font: ["Noto Sans Regular", "Noto Sans CJK KR Regular"]`.
   *  Optional — runtime defaults to its first loaded font.
   *  Weight/italic words ("Regular", "Bold", "Italic", "Light", …)
   *  are STRIPPED at conversion time and surfaced as `fontWeight` /
   *  `fontStyle` below; the names left in this array are the family
   *  portion only (e.g. just "Noto Sans"). Without that split the
   *  browser parses "Noto-Sans-Bold" as a literal family name, fails
   *  to match any installed font, and falls back to the OS default
   *  — every Mapbox style ended up looking like the same Regular
   *  weight regardless of what the style declared. */
  font?: string[]
  /** CSS font-weight derived from the Mapbox `text-font` entry's
   *  trailing keyword. `"Noto Sans Bold"` → 700, `"… Light"` → 300,
   *  etc. Numeric to match the CSS spec range (100..900). Unset =
   *  use CSS default (400). */
  fontWeight?: number
  /** CSS font-style derived from the Mapbox `text-font` entry.
   *  `"… Italic"` / `"… Oblique"` → 'italic'. Unset = 'normal'. */
  fontStyle?: 'normal' | 'italic'
  /** Font size in PIXELS (not font units). Mapbox `text-size`. */
  size: number
  /** Optional zoom-interpolated size override. When set, the runtime
   *  evaluates interpolateZoom(stops, camera.zoom) per frame and uses
   *  the result instead of the constant `size`. Maps from Mapbox
   *  `text-size: ["interpolate", ["linear"], ["zoom"], …]`. */
  sizeZoomStops?: ZoomStop<number>[]
  /** Mapbox `["exponential", N]` curve base for `sizeZoomStops`.
   *  Undefined / 1 → linear; >1 → faster growth at higher zooms. */
  sizeZoomStopsBase?: number
  /** Optional per-feature size expression. Maps from Mapbox data-
   *  driven forms like `["case", ["==", ["get","class"], "city"], 14, 10]`
   *  or `["match", ["get","class"], "city", 14, 10]`. Runtime
   *  evaluates against each feature's props and falls back to
   *  `size` when the expression yields a non-numeric result. */
  sizeExpr?: DataExpr
  /** Mapbox `text-letter-spacing` in em units. Default 0. */
  letterSpacing?: number
  /** Mapbox `text-line-height` in em units. Default 1.2. */
  lineHeight?: number
  /** Mapbox `text-max-width` in em units (wraps at word boundaries
   *  past this). Default ~10. */
  maxWidth?: number
  /** Mapbox `text-transform`. */
  transform?: 'none' | 'uppercase' | 'lowercase'
  /** Mapbox `text-justify`. */
  justify?: 'auto' | 'left' | 'center' | 'right'

  // ── Appearance ──
  /** Text fill colour `[r, g, b, a]` (0-1 each). When undefined
   *  the layer's `fill` value is used as the text colour. */
  color?: [number, number, number, number]
  /** Optional zoom-interpolated colour override. When set, the
   *  runtime evaluates RGBA component-wise per frame and uses the
   *  result instead of the constant `color`. Maps from Mapbox
   *  `text-color: ["interpolate", ["linear"], ["zoom"], …]`. */
  colorZoomStops?: ZoomStop<[number, number, number, number]>[]
  /** Optional per-feature colour expression. Maps from Mapbox data-
   *  driven forms like `["case", ["==", ["get","kind"],"city"], "#000", "#666"]`.
   *  Runtime evaluates per feature; result is parsed via the
   *  shared colour resolver (hex / rgba string / named colour). */
  colorExpr?: DataExpr
  /** Optional halo (outline). `blur` is the SDF feathering width
   *  in pixels — Mapbox `text-halo-blur`. */
  halo?: {
    color: [number, number, number, number]
    width: number
    blur?: number
  }
  /** Zoom-interpolated halo width (Mapbox `text-halo-width:
   *  ["interpolate", ["linear"], ["zoom"], …]`). Overrides
   *  `halo.width` when present. */
  haloWidthZoomStops?: ZoomStop<number>[]
  /** Mapbox `["exponential", N]` curve base for `haloWidthZoomStops`. */
  haloWidthZoomStopsBase?: number
  /** Zoom-interpolated halo colour. Overrides `halo.color`. */
  haloColorZoomStops?: ZoomStop<[number, number, number, number]>[]

  // ── Placement ──
  /** Mapbox `symbol-placement`. `point` (default) anchors text at
   *  the feature's anchor point; `line` lays text along line
   *  geometry; `line-center` puts one label at the line's midpoint. */
  placement?: 'point' | 'line' | 'line-center'
  /** Distance between repeated labels along a line (`placement:
   *  line` only), in pixels. Mapbox `symbol-spacing`. Default 250. */
  spacing?: number
  /** Mapbox `text-anchor`. Default `center`. */
  anchor?:
    | 'center' | 'top' | 'bottom' | 'left' | 'right'
    | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  /** Mapbox `text-variable-anchor` candidates. When set, the runtime
   *  tries each in order during collision and uses the first that
   *  doesn't overlap an existing label. The static `anchor` field
   *  carries the first candidate as a fallback for IR consumers
   *  that don't implement variable placement. */
  anchorCandidates?: Array<
    | 'center' | 'top' | 'bottom' | 'left' | 'right'
    | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  >
  /** Mapbox `text-offset` in em units `[dx, dy]`. */
  offset?: [number, number]
  /** Mapbox `text-translate` in display pixels `[dx, dy]`. Applied
   *  on top of `offset`; differs from offset only by unit (pixels
   *  vs em-units) and by Mapbox spec's "paint" vs "layout" category. */
  translate?: [number, number]
  /** Mapbox `text-rotate` in degrees clockwise. */
  rotate?: number
  /** Padding (px) around the text bbox for collision testing.
   *  Mapbox `text-padding`. Default 2. */
  padding?: number

  // ── Collision (Batch 1e) ──
  /** When true, render even when overlapping other labels.
   *  Mapbox `text-allow-overlap`. */
  allowOverlap?: boolean
  /** When true, do not let this label block others.
   *  Mapbox `text-ignore-placement`. */
  ignorePlacement?: boolean

  // ── Deferred (placeholder typings; semantics defined later) ──
  /** Map / viewport / auto. Default 'auto' — point labels follow
   *  viewport, line labels follow map. Batch 1d. */
  rotationAlignment?: 'map' | 'viewport' | 'auto'
  /** Map / viewport / auto. Default 'auto'. Batch 1d. */
  pitchAlignment?: 'map' | 'viewport' | 'auto'
  /** When true (default), flip labels along curves so they read
   *  upright. `placement: line` only. Batch 1d. */
  keepUpright?: boolean
  /** Horizontal (default) or vertical. CJK vertical text. Batch 1g+. */
  writingMode?: 'horizontal' | 'vertical'

  /** Unified PropertyShape bundle for the four "shape-able" paint
   *  properties (text-size, text-color, text-halo-width,
   *  text-halo-color). Populated by lower.ts alongside the legacy
   *  scalar + `xxxZoomStops` + `xxxExpr` sibling fields above. New
   *  runtime consumers should read paint values through this bundle
   *  instead of stitching the siblings — the same "truth-of-record"
   *  cleanup that Plan Step 1 applied to PaintShapes.
   *
   *  Optional during the migration; will become required once every
   *  runtime callsite reads from `shapes` and the legacy siblings are
   *  deleted (mirror of paint Step 1d). */
  shapes?: import('./property-types').LabelShapes
}

/**
 * Shape reference for point rendering.
 */
export type ShapeRef =
  | { kind: 'none' }                         // circle (analytical default)
  | { kind: 'named'; name: string }          // built-in or user-defined shape
  | { kind: 'data-driven'; expr: DataExpr }  // per-feature shape selection

// ═══ Value types — designed for Phase 1 extension ═══

/**
 * Color can be constant, data-driven, or conditional.
 * Phase 0: only 'constant' is used.
 */
export type ColorValue =
  | { kind: 'constant'; rgba: [number, number, number, number] }
  | { kind: 'none' }
  | { kind: 'data-driven'; expr: DataExpr }
  | { kind: 'conditional'; branches: ConditionalBranch<ColorValue>[]; fallback: ColorValue }
  | {
      kind: 'zoom-interpolated'
      stops: ZoomStop<[number, number, number, number]>[]
      /** Mapbox `["exponential", N]` curve base. Undefined / 1 → linear. */
      base?: number
    }
  | {
      kind: 'time-interpolated'
      /** Fallback color when t < first stop (respecting delay). Used by
       *  emit-commands to pick a sensible `fill:` hex so pre-animation
       *  frames look right. */
      base: [number, number, number, number]
      stops: TimeStop<[number, number, number, number]>[]
      loop: boolean
      easing: Easing
      delayMs: number
    }

/**
 * Stroke combines color and width.
 */
/** One pattern instance in a stroke's pattern stack (up to 3). */
export interface StrokePattern {
  /** Symbol name — must resolve via ShapeRegistry (built-in or user-defined). */
  shape: string
  /** Repeat spacing. */
  spacing: number
  spacingUnit?: 'm' | 'px' | 'km' | 'nm'
  /** Symbol extent (diameter/width). */
  size: number
  sizeUnit?: 'm' | 'px' | 'km' | 'nm'
  /** Perpendicular offset from the line centerline. */
  offset?: number
  offsetUnit?: 'm' | 'px' | 'km' | 'nm'
  /** Arc offset before the first instance (anchored placements). */
  startOffset?: number
  /** Placement mode: repeat (default), start, end, center. */
  anchor?: 'repeat' | 'start' | 'end' | 'center'
}

/** A stroke width expressed as exactly ONE of three mutually-exclusive
 *  forms. Pre-discriminated-union version, `StrokeValue` had four
 *  optional fields (`width: number`, `widthExpr?`, `widthZoomStops?`,
 *  `widthZoomStopsBase?`) where any combination — including all empty
 *  — was a valid TypeScript value. That permitted PR #95 / #97 / #104:
 *  lower.ts emitted a stroke with NONE of the four forms set, the
 *  fallback `width = 1` shipped, and every road on OFM Bright rendered
 *  as a 1-pixel hairline. With the discriminated union, lower.ts MUST
 *  pick a kind — there is no way to construct a `StrokeWidthValue`
 *  that means "no width" except by explicitly writing
 *  `{ kind: 'constant', px: 0 }`. */
export type StrokeWidthValue =
  /** Single static width in CSS pixels. Mapbox `line-width: <number>`. */
  | { kind: 'constant'; px: number }
  /** Per-frame zoom-interpolated width — the renderer evaluates
   *  `interpolateZoom(stops, camera.zoom, base)` each frame. Mapbox
   *  `line-width: ["interpolate", curve, ["zoom"], …]`. */
  | {
      kind: 'zoom-stops'
      stops: ZoomStop<number>[]
      /** Mapbox `["exponential", N]` curve base. 1 / undefined = linear. */
      base?: number
    }
  /** Per-feature AST evaluated by the worker at tile-decode time —
   *  result is baked into the segment buffer's width-override slot.
   *  Mapbox per-feature expressions like
   *  `["match", ["get","class"], "primary", 5, …, 1]`. */
  | { kind: 'per-feature'; expr: DataExpr }

export interface StrokeValue {
  color: ColorValue
  /** Width expressed as a discriminated union — see {@link
   *  StrokeWidthValue}. Required: every stroke MUST resolve to one
   *  of the three kinds. */
  width: StrokeWidthValue
  /** Optional per-feature stroke colour override. Companion to
   *  widthExpr. Synthesised by the merge pass for same-source-layer
   *  groups whose stroke colours differ — a `match(.field) { value
   *  -> #rrggbbaa, ..., _ -> #00000000 }` AST. The worker evaluates
   *  per feature, packs RGBA8 into a u32, and writes it into the
   *  line segment buffer's `color_packed` slot; the shader unpacks
   *  it and uses it when alpha > 0, otherwise falls through to the
   *  layer-uniform colour. The match infrastructure stays in the
   *  AST so future user-authored `stroke: match(.field) { ... }` is
   *  trivially supported once the parser surface lands. */
  colorExpr?: DataExpr
  linecap?: 'butt' | 'round' | 'square' | 'arrow'
  linejoin?: 'miter' | 'round' | 'bevel'
  miterlimit?: number
  /** Dash array in meters (even indices = on, odd = off). */
  dashArray?: number[]
  dashOffset?: number
  /** Up to 3 pattern slots rendered along the line. */
  patterns?: StrokePattern[]
  /** Lateral parallel offset in pixels. Positive = left of travel. */
  offset?: number
  /** Edge feathering width in CSS pixels (Mapbox `paint.line-blur`).
   *  0 (default) preserves crisp 1.5 px AA expansion; positive values
   *  soft-fade the edge over `1.5 + blur` px each side. */
  blur?: number
  /** Stroke alignment relative to the centerline. Default 'center'.
   *  Inset shifts the stroke onto the left side of travel by half-width
   *  (so the stroke's right edge sits on the original line); outset shifts
   *  the other way. Combined with explicit `offset` by addition. */
  align?: 'center' | 'inset' | 'outset'
  // ── Animation (PR 3) ──
  // Parallel time stop lists live on the parent interface instead of
  // promoting `width` / `dashOffset` to a union type — keeps every
  // downstream consumer (emit-commands, renderer, line-renderer) able
  // to read the base scalar without branching, and only checks the
  // stops when animation is actually attached. Shared loop / easing /
  // delay metadata is reused from the opacity animation attached to
  // the same layer (see LayerAnimationMeta on RenderNode below).
  timeWidthStops?: TimeStop<number>[]
  timeDashOffsetStops?: TimeStop<number>[]
}

/**
 * Opacity value. Now a thin alias over the unified `PropertyShape<number>`
 * — every variant the legacy OpacityValue carried (constant / zoom-
 * interpolated / time-interpolated / zoom-time / data-driven) matches
 * PropertyShape one-to-one in both kind name and field shape. The
 * alias means callsites continue to type-check without change; new
 * callsites should reach for `PropertyShape<number>` directly.
 */
export type OpacityValue = import('./property-types').PropertyShape<number>

/** A time stop for keyframe-interpolated values. Time axis is milliseconds
 *  from the start of the animation. */
export interface TimeStop<T> {
  timeMs: number
  value: T
}

/** Easing function used between adjacent time stops. Four CSS presets —
 *  cubic-bezier, steps, and per-segment variants land in later PRs. */
export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

/**
 * Size value for points/symbols.
 */
export type SizeValue =
  | { kind: 'constant'; value: number; unit?: string | null }
  | { kind: 'none' }
  | { kind: 'data-driven'; expr: DataExpr; unit?: string | null }
  | {
      kind: 'zoom-interpolated'
      stops: ZoomStop<number>[]
      /** Mapbox `["interpolate", ["exponential", N], …]` curve base.
       *  Undefined / 1 → linear. */
      base?: number
    }
  | {
      kind: 'time-interpolated'
      stops: TimeStop<number>[]
      loop: boolean
      easing: Easing
      delayMs: number
      unit?: string | null
    }

/**
 * A zoom stop for interpolated values.
 */
export interface ZoomStop<T> {
  zoom: number
  value: T
}

/** 3D extrusion height (metres). `feature.expr` is any AST expression
 *  evaluated against each feature's properties at MVT decode time.
 *  Common forms:
 *    extrude: 50                  → { kind: constant, value: 50 }
 *    extrude: .height             → feature with FieldAccess('height')
 *    extrude: .levels * 3.5       → feature with BinaryExpr
 *    extrude: max(.height, 20)    → feature with FnCall
 *  `fallback` is the height to use when the expression evaluates to
 *  null / undefined / non-finite (e.g. the property is missing). */
export type ExtrudeValue =
  | { kind: 'none' }
  | { kind: 'constant'; value: number }
  | { kind: 'feature'; expr: DataExpr; fallback: number }

/**
 * A conditional branch: applies when a data field matches a value.
 */
export interface ConditionalBranch<T> {
  field: string   // the property/modifier name (e.g., "friendly", "hostile")
  value: T        // the value when condition matches
}

/**
 * A reference to an AST expression for per-feature evaluation.
 * Stored as the raw AST Expr node — evaluated at runtime per feature.
 */
export interface DataExpr {
  ast: import('../parser/ast').Expr
  classification?: import('./classify').ExprClass
}

// ═══ Helpers ═══

export function colorNone(): ColorValue {
  return { kind: 'none' }
}

export function colorConstant(r: number, g: number, b: number, a: number = 1): ColorValue {
  return { kind: 'constant', rgba: [r, g, b, a] }
}

export function opacityConstant(value: number): OpacityValue {
  return { kind: 'constant', value }
}

export function sizeNone(): SizeValue {
  return { kind: 'none' }
}

export function sizeConstant(value: number, unit?: string | null): SizeValue {
  return { kind: 'constant', value, unit: unit ?? null }
}

export function shapeNone(): ShapeRef {
  return { kind: 'none' }
}

/** Build the unified PropertyShape bundle for a label from the
 *  populated LabelDef mixed-bag fields. Pure transformation — same
 *  inputs always produce the same shapes. Precedence within each
 *  axis matches the runtime resolver in `map.ts:2710-2800` (the
 *  pre-migration source of truth):
 *
 *    data-driven (xxxExpr) > zoom-interpolated (xxxZoomStops) > constant
 *
 *  `size` always returns a non-null PropertyShape because the runtime
 *  needs a numeric font size for every label; the other three return
 *  `null` when the source omitted that axis. */
export function buildLabelShapes(
  label: import('./render-node').LabelDef,
): import('./property-types').LabelShapes {
  type RGBA = readonly [number, number, number, number]
  type Shape<T> = import('./property-types').PropertyShape<T>

  // text-size — always present. Default 16 px matches the Mapbox spec.
  let size: Shape<number>
  if (label.sizeExpr) {
    size = { kind: 'data-driven', expr: label.sizeExpr }
  } else if (label.sizeZoomStops && label.sizeZoomStops.length > 0) {
    size = {
      kind: 'zoom-interpolated',
      stops: label.sizeZoomStops,
      ...(label.sizeZoomStopsBase !== undefined
        ? { base: label.sizeZoomStopsBase } : {}),
    }
  } else {
    size = { kind: 'constant', value: label.size }
  }

  // text-color — null when omitted (runtime falls back to layer fill).
  let color: Shape<RGBA> | null = null
  if (label.colorExpr) {
    color = { kind: 'data-driven', expr: label.colorExpr }
  } else if (label.colorZoomStops && label.colorZoomStops.length > 0) {
    color = { kind: 'zoom-interpolated', stops: label.colorZoomStops }
  } else if (label.color) {
    color = { kind: 'constant', value: label.color }
  }

  // text-halo-width — null when no halo authored.
  let haloWidth: Shape<number> | null = null
  if (label.haloWidthZoomStops && label.haloWidthZoomStops.length > 0) {
    haloWidth = {
      kind: 'zoom-interpolated',
      stops: label.haloWidthZoomStops,
      ...(label.haloWidthZoomStopsBase !== undefined
        ? { base: label.haloWidthZoomStopsBase } : {}),
    }
  } else if (label.halo?.width !== undefined) {
    haloWidth = { kind: 'constant', value: label.halo.width }
  }

  // text-halo-color — null when no halo authored.
  let haloColor: Shape<RGBA> | null = null
  if (label.haloColorZoomStops && label.haloColorZoomStops.length > 0) {
    haloColor = { kind: 'zoom-interpolated', stops: label.haloColorZoomStops }
  } else if (label.halo?.color) {
    haloColor = { kind: 'constant', value: label.halo.color }
  }

  return { size, color, haloWidth, haloColor }
}

/**
 * Parse hex color string to RGBA tuple (0-1 range).
 */
export function hexToRgba(hex: string): [number, number, number, number] {
  let r = 0, g = 0, b = 0, a = 1

  if (hex.length === 4) {
    // #RGB
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
  } else if (hex.length === 7) {
    // #RRGGBB
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
  } else if (hex.length === 9) {
    // #RRGGBBAA
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
    a = parseInt(hex.slice(7, 9), 16) / 255
  }

  return [r, g, b, a]
}

/**
 * Convert RGBA tuple (0-1) to hex string.
 */
export function rgbaToHex(rgba: [number, number, number, number]): string {
  const [r, g, b, a] = rgba
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  if (a >= 0.999) {
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(a)}`
}
