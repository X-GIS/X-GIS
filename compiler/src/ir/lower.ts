// ═══ AST → IR Lowering Pass ═══
// Converts parsed AST into the intermediate representation (Scene).
// Handles both legacy (let/show) and new (source/layer) syntax.

import type * as AST from '../parser/ast'
import { parseExpressionString } from '../parser/parser'
import { parseTextTemplate, isBareExpressionTemplate } from '../format'
import type { TextValue, TextPart } from './render-node'
import { resolveColor } from '../tokens/colors'
import {
  type Scene,
  type SourceDef,
  type RenderNode,
  type ColorValue,
  type SizeValue,
  type OpacityValue,
  type ZoomStop,
  type TimeStop,
  type Easing,
  type ConditionalBranch,
  colorNone,
  colorConstant,
  opacityConstant,
  sizeNone,
  sizeConstant,
  shapeNone,
  hexToRgba,
  buildLabelShapes,
  type ShapeRef,
} from './render-node'

/** Lower-pass options. Reserved for opt-in features that change the
 *  IR shape produced from a given AST — bypass flags for collapses
 *  that exist because a runtime feature wasn't available yet. */
export interface LowerOptions {
  /** Skip `extractMatchDefaultColor` for fill bindings (the second
   *  Mapbox `match(.field) { ..., _ -> default }` collapse — see
   *  `convert/mapbox-to-xgis.ts:bypassExpandColorMatch` for the
   *  first). When true, the match() expression survives as
   *  `kind: 'data-driven'` so the P4 compute path (or the fragment-
   *  shader if-else fallback for variants with per-feature props)
   *  evaluates every arm GPU-side.
   *
   *  Default false (preserves existing collapse-to-default
   *  behaviour). Combined with `bypassExpandColorMatch: true`,
   *  this is the second half of the gate that lets Mapbox styles
   *  flow large match() expressions into the compute path. Without
   *  the runtime support (VTR compute integration), the lowered
   *  data-driven shape STILL renders correctly via the existing
   *  fragment-shader if-else path for any source that has a
   *  populated PropertyTable + variant.featureFields wired in
   *  (commit ba348aa). */
  bypassExtractMatchDefaultColor?: boolean
}

/**
 * Lower an AST Program into an IR Scene.
 */
export function lower(program: AST.Program, options: LowerOptions = {}): Scene {
  const sources: SourceDef[] = []
  const renderNodes: RenderNode[] = []
  const symbols: import('./render-node').SymbolDef[] = []
  const diagnostics: import('./render-node').Diagnostic[] = []
  const sourceMap = new Map<string, SourceDef>()
  const presetMap = new Map<string, AST.UtilityLine[]>()
  const styleMap = new Map<string, AST.StyleProperty[]>()
  const keyframesMap = new Map<string, AST.KeyframesStatement>()

  // First pass: collect presets, styles, symbols, and keyframes. Keyframes
  // must land in the symbol table before any layer is lowered so forward
  // references like `animation-pulse` resolve regardless of declaration
  // order in the source file.
  for (const stmt of program.body) {
    if (stmt.kind === 'PresetStatement') {
      presetMap.set(stmt.name, stmt.utilities)
    } else if (stmt.kind === 'StyleStatement') {
      styleMap.set(stmt.name, stmt.properties)
    } else if (stmt.kind === 'SymbolStatement') {
      const paths: string[] = []
      for (const el of stmt.elements) {
        if (el.kind === 'path') paths.push(el.data)
      }
      if (paths.length > 0) symbols.push({ name: stmt.name, paths })
    } else if (stmt.kind === 'KeyframesStatement') {
      keyframesMap.set(stmt.name, stmt)
    }
  }

  for (const stmt of program.body) {
    switch (stmt.kind) {
      case 'PresetStatement':
      case 'StyleStatement':
      case 'KeyframesStatement':
        break // already processed in first pass
      case 'SourceStatement': {
        const src = lowerSource(stmt)
        if (src) {
          sources.push(src)
          sourceMap.set(src.name, src)
        }
        break
      }
      case 'LayerStatement': {
        const node = lowerLayer(stmt, sourceMap, presetMap, styleMap, keyframesMap, diagnostics, options)
        if (node) {
          // If the source was referenced but not yet added, add it
          if (!sources.find(s => s.name === node.sourceRef)) {
            const src = sourceMap.get(node.sourceRef)
            if (src) sources.push(src)
          }
          renderNodes.push(node)
        }
        break
      }
      case 'LetStatement': {
        const src = lowerLetAsSource(stmt)
        if (src) {
          sources.push(src)
          sourceMap.set(src.name, src)
        }
        break
      }
      case 'ShowStatement': {
        const node = lowerShow(stmt)
        if (node) renderNodes.push(node)
        break
      }
    }
  }

  return { sources, renderNodes, symbols, diagnostics }
}

/** Detect the `interpolate(zoom, k1, v1, k2, v2, …)` call shape and
 *  extract numeric (zoom, value) stops. Returns null when the AST
 *  isn't that exact shape — other inputs (feature properties, etc.)
 *  or non-numeric values fall through to the generic data-driven
 *  evaluator path. Used by the binding lowerer to short-circuit
 *  zoom-only uses straight onto the existing ZoomStop<number>[]
 *  zoom-interpolation infrastructure (no per-frame eval, no per-
 *  feature plumbing — the existing kind:'zoom-interpolated' code
 *  paths in the runtime do the heavy lifting). */
/** Convert the AST.Expr bound to a `label-[<binding>]` utility into
 *  a TextValue. When the binding is a string literal we treat it as
 *  a text template (see compiler/src/format/template-parser.ts) so
 *  patterns like `label-["Lat: {lat:.4f}°N"]` resolve into per-feature
 *  formatted strings. Bare-expression bindings (`label-[.name]`) and
 *  templates that collapse to a single bare interp (`label-["{name}"]`)
 *  return the legacy `kind:'expr'` shape so the renderer doesn't have
 *  to walk a single-part template at runtime. */
function bindingToTextValue(binding: AST.Expr): TextValue {
  if (binding.kind !== 'StringLiteral') {
    return { kind: 'expr', expr: { ast: binding } }
  }
  const parts = parseTextTemplate(binding.value)
  // "abc" with no interps — wrap as a single-literal template so the
  // text resolver always emits the constant string. Don't try to coax
  // it into kind:'expr' (DataExpr expects an AST, not a string).
  if (parts.length === 0) {
    return { kind: 'template', parts: [{ kind: 'literal', value: '' }] }
  }
  if (isBareExpressionTemplate(parts)) {
    const interp = parts[0] as { kind: 'interp'; text: string }
    return { kind: 'expr', expr: { ast: parseExpressionString(interp.text) } }
  }
  const irParts: TextPart[] = parts.map(p => {
    if (p.kind === 'literal') return { kind: 'literal', value: p.text }
    return {
      kind: 'interp',
      expr: { ast: parseExpressionString(p.text) },
      ...(p.spec ? { spec: p.spec } : {}),
    }
  })
  return { kind: 'template', parts: irParts }
}

/** Extract a constant number from a utility binding, supporting the
 *  bracket form for negatives that the utility-name grammar can't
 *  express inline (`label-offset-y-[-0.2]`, `label-rotate-[-30]`).
 *  Accepts a `NumberLiteral` directly OR a `UnaryExpr` wrapping one.
 *  Returns null for anything else (data-driven / non-numeric) — caller
 *  falls through to its data-driven branch. */
function bindingAsConstantNumber(binding: AST.Expr): number | null {
  if (binding.kind === 'NumberLiteral') return binding.value
  if (binding.kind === 'UnaryExpr' && binding.op === '-'
      && binding.operand.kind === 'NumberLiteral') {
    return -binding.operand.value
  }
  return null
}

/** Result of pulling stops out of an `interpolate(...)` /
 *  `interpolate_exp(...)` binding. `base === 1` indicates the linear
 *  branch (i.e. `interpolate(zoom, …)` with no explicit curve). */
export interface ZoomStopsWithBase<T> {
  base: number
  stops: Array<{ zoom: number; value: T }>
}

/** When the binding is `match(.field) { "k" -> #color, …, _ -> #color }`,
 *  pull the default arm's colour out as a hex string. Used by the
 *  `name === 'fill'` arm to provide a constant fallback when the
 *  full per-feature data-driven path isn't yet wired through to the
 *  fill renderer. The converter lowers Mapbox `["match", input, k,
 *  v, …, default]` into this shape via `expressions.ts:111`. */
function extractMatchDefaultColor(expr: AST.Expr): string | null {
  if (expr.kind !== 'FnCall') return null
  if (expr.callee.kind !== 'Identifier' || expr.callee.name !== 'match') return null
  const matchBlock = expr.matchBlock
  if (!matchBlock) return null
  for (const arm of matchBlock.arms) {
    if (arm.pattern === '_') {
      if (arm.value.kind === 'ColorLiteral') return arm.value.value
      // The converter sometimes wraps the default in resolveColor at
      // emit time; we accept hex-shaped string literals too.
      if (arm.value.kind === 'StringLiteral' && /^#/.test(arm.value.value)) {
        return arm.value.value
      }
    }
  }
  return null
}

function extractInterpolateZoomStops(
  expr: AST.Expr,
): ZoomStopsWithBase<number> | null {
  if (expr.kind !== 'FnCall') return null
  if (expr.callee.kind !== 'Identifier') return null
  const calleeName = expr.callee.name
  const isExp = calleeName === 'interpolate_exp'
  if (!isExp && calleeName !== 'interpolate') return null
  const args = expr.args
  if (args.length < 3) return null
  // Exponential carries a leading `base` argument before the zoom keyword:
  //   interpolate_exp(zoom, BASE, z1, v1, z2, v2, …)
  // Linear:
  //   interpolate(zoom, z1, v1, z2, v2, …)
  // So peel the base first when exponential, then the rest is identical.
  let cursor = 0
  const input = args[cursor++]
  if (input.kind !== 'Identifier' || input.name !== 'zoom') return null
  let base = 1
  if (isExp) {
    const baseArg = args[cursor++]
    if (baseArg === undefined || baseArg.kind !== 'NumberLiteral') return null
    base = baseArg.value
  }
  // Remaining args must alternate (numeric zoom, numeric value).
  const remaining = args.length - cursor
  if (remaining < 4 || remaining % 2 !== 0) return null
  const stops: Array<{ zoom: number; value: number }> = []
  for (let i = cursor; i + 1 < args.length; i += 2) {
    const zArg = args[i]
    const vArg = args[i + 1]
    if (zArg.kind !== 'NumberLiteral' || vArg.kind !== 'NumberLiteral') return null
    stops.push({ zoom: zArg.value, value: vArg.value })
  }
  return stops.length >= 2 ? { base, stops } : null
}

/** Pull the full set of `(zoom, color)` stops from an `interpolate(
 *  zoom, z0, c0, z1, c1, …)` binding. Returns null when the
 *  expression isn't an interpolate-by-zoom OR any value isn't a
 *  ColorLiteral. The runtime interpolates RGBA component-wise per
 *  frame so a colour fade at low zoom (e.g. text fading from grey
 *  at z5 to black at z14) matches Mapbox's continuous interp rather
 *  than snapping at one of the endpoints. */
function extractInterpolateZoomColorStops(
  expr: AST.Expr,
): Array<{ zoom: number; value: string }> | null {
  if (expr.kind !== 'FnCall') return null
  if (expr.callee.kind !== 'Identifier' || expr.callee.name !== 'interpolate') return null
  const args = expr.args
  if (args.length < 5) return null  // zoom, z0, c0, z1, c1 minimum
  if (args[0].kind !== 'Identifier' || args[0].name !== 'zoom') return null
  if ((args.length - 1) % 2 !== 0) return null
  const stops: Array<{ zoom: number; value: string }> = []
  for (let i = 1; i + 1 < args.length; i += 2) {
    const zArg = args[i]
    const vArg = args[i + 1]
    if (zArg.kind !== 'NumberLiteral') return null
    if (vArg.kind !== 'ColorLiteral') return null
    stops.push({ zoom: zArg.value, value: vArg.value })
  }
  return stops.length >= 2 ? stops : null
}

// ═══ New syntax lowering ═══

function lowerSource(stmt: AST.SourceStatement): SourceDef | null {
  let type = 'geojson'
  let url = ''
  let layers: string[] | undefined

  for (const prop of stmt.properties) {
    if (prop.name === 'type' && prop.value.kind === 'Identifier') {
      type = prop.value.name
    } else if (prop.name === 'url' && prop.value.kind === 'StringLiteral') {
      url = prop.value.value
    } else if (prop.name === 'layers') {
      // Accept either `layers: "water"` (single MVT layer) or
      // `layers: ["water", "roads"]` (subset). PMTiles backend uses
      // this to filter MVT features before decompose+compile so each
      // xgis layer can paint its own slice with its own style.
      if (prop.value.kind === 'StringLiteral') {
        layers = [prop.value.value]
      } else if (prop.value.kind === 'ArrayLiteral') {
        const out: string[] = []
        for (const el of prop.value.elements) {
          if (el.kind === 'StringLiteral') out.push(el.value)
        }
        if (out.length > 0) layers = out
      }
    }
  }

  // Inline source (no url) — runtime seeds with an empty FeatureCollection
  // and the host fills it via setSourceData / setSourcePoints.
  return { name: stmt.name, type, url, layers }
}

function lowerLayer(
  stmt: AST.LayerStatement,
  sourceMap: Map<string, SourceDef>,
  presetMap: Map<string, AST.UtilityLine[]>,
  styleMap: Map<string, AST.StyleProperty[]>,
  keyframesMap: Map<string, AST.KeyframesStatement>,
  diagnostics: import('./render-node').Diagnostic[],
  options: LowerOptions,
): RenderNode | null {
  // Extract block properties
  let sourceRef = ''
  let sourceLayer: string | undefined
  let zOrder = 0
  let minzoom: number | undefined
  let maxzoom: number | undefined
  let styleRef = ''
  let filterExpr: import('../parser/ast').Expr | null = null
  let geometryExpr: import('../parser/ast').Expr | null = null
  let extrude: import('./render-node').ExtrudeValue = { kind: 'none' }
  let extrudeBase: import('./render-node').ExtrudeValue = { kind: 'none' }
  // Per-feature text label. The text comes from `label-[<expr>]`;
  // visual knobs (size, color, halo, anchor, transform) come from
  // sibling `label-*` utilities that fold into the LabelDef when we
  // assemble the RenderNode below. Engine plumbing in Batch 1c.
  let label: import('./render-node').LabelDef | undefined
  let labelSize: number | undefined
  const labelSizeZoomStops: ZoomStop<number>[] = []
  // Mapbox `["interpolate", ["exponential", N], ["zoom"], …]` base
  // for the size curve. 1 (default) → linear; > 1 → faster growth
  // near the upper zoom stop, the OFM Bright road-width convention.
  let labelSizeZoomStopsBase: number | undefined
  let labelColor: [number, number, number, number] | undefined
  const labelColorZoomStops: ZoomStop<[number, number, number, number]>[] = []
  let labelColorExpr: import('./render-node').DataExpr | undefined
  let labelSizeExpr: import('./render-node').DataExpr | undefined
  let labelHaloWidth: number | undefined
  const labelHaloWidthZoomStops: ZoomStop<number>[] = []
  let labelHaloWidthZoomStopsBase: number | undefined
  let labelHaloColor: [number, number, number, number] | undefined
  const labelHaloColorZoomStops: ZoomStop<[number, number, number, number]>[] = []
  let labelHaloBlur: number | undefined
  let labelSpacing: number | undefined
  let labelRotationAlignment: 'map' | 'viewport' | 'auto' | undefined
  let labelPitchAlignment: 'map' | 'viewport' | 'auto' | undefined
  let labelKeepUpright: boolean | undefined
  let labelAnchor: import('./render-node').LabelDef['anchor'] | undefined
  // Collect every label-anchor-X utility seen — Mapbox text-variable-
  // anchor maps to multiple emissions by the converter, in priority
  // order. The runtime tries each on collision; first non-colliding
  // wins. Single-anchor styles still produce a one-element list and
  // foldLabelKnobs strips it down to just `anchor`.
  const labelAnchorCandidates: NonNullable<import('./render-node').LabelDef['anchorCandidates']> = []
  let labelTransform: import('./render-node').LabelDef['transform'] | undefined
  let labelOffsetX: number | undefined
  let labelOffsetY: number | undefined
  let labelTranslateX: number | undefined
  let labelTranslateY: number | undefined
  let labelRadialOffset: number | undefined
  // `text-variable-anchor-offset` em offsets, keyed by the 0-based
  // pair index the converter emitted; zipped back onto the ordered
  // anchor candidates at assembly time.
  const labelVao: Array<[number, number] | undefined> = []
  const setVao = (idx: number, axis: string, n: number): void => {
    const cur = labelVao[idx] ?? [0, 0]
    if (axis === 'x') cur[0] = n
    else if (axis === 'y') cur[1] = n
    labelVao[idx] = cur
  }
  let labelAllowOverlap: boolean | undefined
  let labelIgnorePlacement: boolean | undefined
  let labelPadding: number | undefined
  let labelRotate: number | undefined
  let labelLetterSpacing: number | undefined
  let labelFontStack: string[] | undefined
  let labelFontWeight: number | undefined
  let labelFontStyle: 'normal' | 'italic' | undefined
  let labelMaxWidth: number | undefined
  let labelLineHeight: number | undefined
  let labelJustify: 'auto' | 'left' | 'center' | 'right' | undefined
  let labelPlacement: 'point' | 'line' | 'line-center' | undefined
  // ── Icon (Batch 2) ──
  let labelIconImage: string | undefined
  let labelIconSize: number | undefined
  let labelIconAnchor: import('./render-node').LabelDef['iconAnchor'] | undefined
  let labelIconOffset: [number, number] | undefined
  let labelIconRotate: number | undefined

  for (const prop of stmt.properties) {
    if (prop.name === 'source' && prop.value.kind === 'Identifier') {
      sourceRef = prop.value.name
    } else if (prop.name === 'sourceLayer' && prop.value.kind === 'StringLiteral') {
      // sourceLayer: pick one MVT layer from a multi-layer source.
      // Mapbox-style spec uses kebab-case `source-layer`; we use
      // camelCase since the lexer doesn't accept hyphens in
      // identifiers. Semantics are the same.
      sourceLayer = prop.value.value
    } else if (prop.name === 'z-order' && prop.value.kind === 'NumberLiteral') {
      zOrder = prop.value.value
    } else if (prop.name === 'minzoom' && prop.value.kind === 'NumberLiteral') {
      // Mapbox `layer.minzoom` — layer is invisible BELOW this zoom.
      // Critical for low-zoom views: without enforcement, place
      // sub-layers (label_city minz=3, label_state minz=5, label_town
      // minz=6, label_village minz=9, label_other minz=8, all POIs
      // minz=15+) all render at z=1 simultaneously, piling every
      // OMT feature on the screen and turning the antimeridian view
      // into a stack of all-world labels. The runtime gates per-frame
      // visibility on `(camera.zoom >= minzoom) && (camera.zoom <
      // maxzoom)` via the show command.
      minzoom = prop.value.value
    } else if (prop.name === 'maxzoom' && prop.value.kind === 'NumberLiteral') {
      maxzoom = prop.value.value
    } else if (prop.name === 'style' && prop.value.kind === 'Identifier') {
      styleRef = prop.value.name
    } else if (prop.name === 'filter') {
      filterExpr = prop.value
    } else if (prop.name === 'geometry') {
      geometryExpr = prop.value
    }
  }

  if (!sourceRef) {
    diagnostics.push({
      severity: 'warn',
      code: 'X-GIS0002',
      line: stmt.line,
      message:
        `Layer "${stmt.name}" has no \`source:\` declaration — ` +
        `the layer is dropped from the scene. Add \`source: <name>\` ` +
        `to a top-level \`source\` block.`,
    })
    return null
  }
  if (!sourceMap.has(sourceRef)) {
    const known = [...sourceMap.keys()]
    diagnostics.push({
      severity: 'warn',
      code: 'X-GIS0003',
      line: stmt.line,
      message:
        `Layer "${stmt.name}" references unknown source "${sourceRef}". ` +
        (known.length > 0
          ? `Known sources: ${known.map(k => `"${k}"`).join(', ')}. `
          : 'No sources are declared in this program. ') +
        `The layer is dropped from the scene; check for a typo or ` +
        `re-order the file so the \`source\` block precedes the \`layer\`.`,
    })
    return null
  }

  // Expand presets: apply-name → inline preset's utility items
  const expandedUtilities = expandPresets(stmt.utilities, presetMap)

  // Process utility lines
  let fill: ColorValue = colorNone()
  let strokeColor: ColorValue = colorNone()
  let strokeWidth = 1
  /** Per-feature / zoom-interpolated stroke-width AST. Populated from
   *  `stroke-[<expr>]` bracket bindings when the expression is numeric
   *  (Mapbox `paint.line-width: ["interpolate", …]` or per-feature
   *  case/match). Stroke colour zoom-interpolation takes a parallel
   *  path through `strokeColor` (kind: 'zoom-interpolated'). */
  let strokeWidthExpr: import('./render-node').DataExpr | undefined
  /** Per-feature stroke-colour AST. Populated from `stroke-[<expr>]`
   *  whose binding's `extractMatchDefaultColor` returns a hex —
   *  parallel to fill's data-driven kind. Mirror of the merge-pass
   *  synthesised strokeColorExpr; the runtime line-renderer's worker
   *  evaluates this against each feature and packs RGBA8 into the
   *  segment buffer's `color_packed` slot. */
  let strokeColorExpr: import('./render-node').DataExpr | undefined
  /** Pure zoom-only stroke-width stops — populated when the binding's
   *  expression is a `interpolate(zoom, …)` / `interpolate_exp(zoom,
   *  base, …)` with no feature-prop dependency. Routed through
   *  `stroke.widthZoomStops` so the renderer recomputes width per
   *  frame from camera zoom (avoids the tile-bake staleness). */
  let strokeWidthZoomStops: ZoomStop<number>[] | undefined
  let strokeWidthZoomStopsBase: number | undefined
  let linecap: 'butt' | 'round' | 'square' | 'arrow' | undefined
  let linejoin: 'miter' | 'round' | 'bevel' | undefined
  let miterlimit: number | undefined
  let dashArray: number[] | undefined
  let dashOffset: number | undefined
  let strokeOffset: number | undefined
  let strokeAlign: 'center' | 'inset' | 'outset' | undefined
  let strokeBlur: number | undefined
  // Phase 4: pattern stack — up to 3 slots. Slot 0 = `stroke-pattern-*`,
  // slots 1/2 = `stroke-pattern-1-*` / `stroke-pattern-2-*`.
  const patternSlots: import('./render-node').StrokePattern[] = [
    { shape: '', spacing: 0, size: 0 },
    { shape: '', spacing: 0, size: 0 },
    { shape: '', spacing: 0, size: 0 },
  ]
  const patternDirty = [false, false, false]

  const parsePatternAttr = (rest: string, slotIdx: number): void => {
    const p = patternSlots[slotIdx]
    const unitRe = /^(-?[\d.]+)(m|px|km|nm)?$/
    if (rest.startsWith('spacing-')) {
      const m = rest.slice('spacing-'.length).match(unitRe)
      if (m) { p.spacing = parseFloat(m[1]); p.spacingUnit = (m[2] as 'm' | 'px' | 'km' | 'nm' | undefined) ?? 'm'; patternDirty[slotIdx] = true }
      return
    }
    if (rest.startsWith('size-')) {
      const m = rest.slice('size-'.length).match(unitRe)
      if (m) { p.size = parseFloat(m[1]); p.sizeUnit = (m[2] as 'm' | 'px' | 'km' | 'nm' | undefined) ?? 'm'; patternDirty[slotIdx] = true }
      return
    }
    if (rest.startsWith('offset-')) {
      const m = rest.slice('offset-'.length).match(unitRe)
      if (m) { p.offset = parseFloat(m[1]); p.offsetUnit = (m[2] as 'm' | 'px' | 'km' | 'nm' | undefined) ?? 'm'; patternDirty[slotIdx] = true }
      return
    }
    if (rest.startsWith('anchor-')) {
      const v = rest.slice('anchor-'.length)
      if (v === 'repeat' || v === 'start' || v === 'end' || v === 'center') {
        p.anchor = v; patternDirty[slotIdx] = true
      }
      return
    }
    // Fallback: treat rest as shape name
    p.shape = rest
    patternDirty[slotIdx] = true
  }
  let opacity: OpacityValue = opacityConstant(1.0)
  let size: SizeValue = sizeNone()
  let projection = 'mercator'
  let visible = true
  let pointerEvents: 'auto' | 'none' = 'auto'
  let billboard = true
  let anchor: 'center' | 'bottom' | 'top' | undefined
  let shape: ShapeRef = shapeNone()

  // Cascade order: named style → inline CSS → utilities
  // 1. Apply named style (lowest priority)
  if (styleRef) {
    const namedProps = styleMap.get(styleRef)
    if (namedProps) {
      const result = applyStyleProperties(namedProps, fill, strokeColor, strokeWidth, opacity, projection, visible)
      fill = result.fill; strokeColor = result.strokeColor; strokeWidth = result.strokeWidth
      opacity = result.opacity; projection = result.projection; visible = result.visible
      if (result.linecap) linecap = result.linecap
      if (result.linejoin) linejoin = result.linejoin
      if (result.miterlimit !== undefined) miterlimit = result.miterlimit
      if (result.dashArray) dashArray = result.dashArray
      if (result.dashOffset !== undefined) dashOffset = result.dashOffset
      if (result.strokeOffset !== undefined) strokeOffset = result.strokeOffset
      if (result.strokeAlign !== undefined) strokeAlign = result.strokeAlign
      if (result.pattern) {
        Object.assign(patternSlots[0], result.pattern)
        patternDirty[0] = true
      }
    }
  }

  // 2. Apply inline CSS-like properties (overrides named style)
  if (stmt.styleProperties.length > 0) {
    const result = applyStyleProperties(stmt.styleProperties, fill, strokeColor, strokeWidth, opacity, projection, visible)
    fill = result.fill; strokeColor = result.strokeColor; strokeWidth = result.strokeWidth
    opacity = result.opacity; projection = result.projection; visible = result.visible
    if (result.linecap) linecap = result.linecap
    if (result.linejoin) linejoin = result.linejoin
    if (result.miterlimit !== undefined) miterlimit = result.miterlimit
    if (result.dashArray) dashArray = result.dashArray
    if (result.dashOffset !== undefined) dashOffset = result.dashOffset
    if (result.strokeOffset !== undefined) strokeOffset = result.strokeOffset
    if (result.strokeAlign !== undefined) strokeAlign = result.strokeAlign
    if (result.pattern) {
      Object.assign(patternSlots[0], result.pattern)
      patternDirty[0] = true
    }
  }

  // Collectors for modifier-based values
  const fillBranches: ConditionalBranch<ColorValue>[] = []
  const opacityZoomStops: ZoomStop<number>[] = []
  const sizeZoomStops: ZoomStop<number>[] = []
  // Mapbox `["interpolate", ["exponential", N], …]` base — preserved
  // here so the runtime applies the same accelerated curve Mapbox
  // does. 1 (the default) is mathematically linear; OFM Bright's
  // 65 road-width interpolations sit between 1.3 and 1.5.
  let opacityZoomStopsBase: number | undefined
  let sizeZoomStopsBase: number | undefined

  // Animation metadata. Collected from top-level utilities like
  // `animation-pulse duration-1500 ease-in-out infinite delay-200` on the
  // layer's utility line. The actual keyframe expansion happens once after
  // the utility loop completes, so the order of `animation-*` vs
  // `duration-*` on the same line doesn't matter.
  let animationName: string | null = null
  let animationDurationMs = 1000
  let animationEasing: Easing = 'linear'
  let animationDelayMs = 0
  let animationLoop = false

  for (const line of expandedUtilities) {
    for (const item of line.items) {
      const name = item.name
      const mod = item.modifier

      // ── Modifier items ──
      if (mod) {
        // STRICT: detect the deprecated `z<N>:` zoom-modifier shape.
        // Until f2f8929 this meant "apply at zoom N"; afterwards `z8`
        // is just an identifier the lower pass treats as a feature-
        // property predicate, which silently always-fails on real
        // data. We fail loud here so the issue surfaces in CI / on
        // the /convert page instead of producing wrong output.
        if (/^z\d+$/.test(mod)) {
          const zoomLevel = mod.slice(1)
          diagnostics.push({
            severity: 'warn',
            code: 'X-GIS0001',
            line: stmt.line,
            message:
              `Deprecated zoom modifier "${mod}:" — replaced by ` +
              `\`<utility>-[interpolate(zoom, …)]\`. e.g. ` +
              `\`${mod}:opacity-40\` → ` +
              `\`opacity-[interpolate(zoom, ${zoomLevel}, 40)]\`. ` +
              `Without the migration, the modifier is treated as a ` +
              `feature-property predicate (\`feat.${mod}\`), is ` +
              `always falsy on real data, and the utility never applies.`,
          })
          continue
        }
        // Data modifier: friendly:fill-green-500
        // (Zoom-driven values used to live behind `zN:opacity-…`
        // modifiers; they're now expressed as `opacity-[interpolate(
        // zoom, …)]` and lowered below in the binding handler.)
        if (name.startsWith('fill-')) {
          const hex = resolveColor(name.slice(5))
          if (hex) {
            fillBranches.push({ field: mod, value: colorConstant(...hexToRgba(hex)) })
          }
        }
        continue
      }

      // ── Unmodified items ──

      // Data binding: fill-[expr], size-[expr], opacity-[expr],
      // fill-extrusion-height-[expr], fill-extrusion-base-[expr].
      // Zoom-driven path: an `interpolate(zoom, k1, v1, k2, v2, …)`
      // call with all-numeric stops lowers to the existing
      // ZoomStop<number>[] mechanism for opacity / size. Other
      // utilities and non-numeric stops fall through to the generic
      // data-driven branch (the runtime evaluator handles `zoom`
      // and `interpolate` as builtins).
      if (item.binding) {
        const zoomStops = extractInterpolateZoomStops(item.binding)
        if (zoomStops && name === 'opacity') {
          for (const s of zoomStops.stops) {
            opacityZoomStops.push({
              zoom: s.zoom,
              value: s.value <= 1 ? s.value : s.value / 100,
            })
          }
          if (zoomStops.base !== 1) opacityZoomStopsBase = zoomStops.base
          continue
        }
        if (zoomStops && name === 'size') {
          for (const s of zoomStops.stops) sizeZoomStops.push({ zoom: s.zoom, value: s.value })
          if (zoomStops.base !== 1) sizeZoomStopsBase = zoomStops.base
          continue
        }
        if (zoomStops && name === 'label-size') {
          for (const s of zoomStops.stops) labelSizeZoomStops.push({ zoom: s.zoom, value: s.value })
          if (zoomStops.base !== 1) labelSizeZoomStopsBase = zoomStops.base
          continue
        }
        // Non-zoom-interp label-size binding → per-feature evaluation.
        // Catches Mapbox `text-size: ["case", …]` / `["match", …]` /
        // arithmetic forms. The static `size` field stays at its
        // default (12) to feed any consumer that ignores sizeExpr.
        if (name === 'label-size' && !zoomStops) {
          labelSizeExpr = { ast: item.binding }
          continue
        }
        // label-halo zoom-interpolated width → full stops; runtime
        // interpolates per-frame. Last stop also seeds `halo.width`
        // as the static fallback when the runtime can't evaluate
        // (e.g. consumers reading the IR directly without a camera).
        if (zoomStops && name === 'label-halo') {
          for (const s of zoomStops.stops) labelHaloWidthZoomStops.push({ zoom: s.zoom, value: s.value })
          if (zoomStops.base !== 1) labelHaloWidthZoomStopsBase = zoomStops.base
          labelHaloWidth = zoomStops.stops[zoomStops.stops.length - 1]!.value
          continue
        }
        // label-color zoom-interpolated colour — full stops, RGBA
        // arrays. Runtime walks `colorZoomStops` per frame and
        // component-interpolates. The static `color` field is
        // populated from the last stop so non-interp consumers
        // still see a sensible value.
        if (name === 'label-color') {
          const stops = extractInterpolateZoomColorStops(item.binding)
          if (stops) {
            for (const s of stops) {
              const hex = resolveColor(s.value)
              if (hex) labelColorZoomStops.push({ zoom: s.zoom, value: hexToRgba(hex) })
            }
            if (labelColorZoomStops.length > 0) {
              labelColor = labelColorZoomStops[labelColorZoomStops.length - 1]!.value
              continue
            }
          }
          // Non-zoom-interp colour binding → per-feature expression.
          // Catches `label-color-[.kind == "city" ? #ff0000 : #000000]`
          // (the Mapbox `text-color: ["case", …]` shape). Runtime
          // evaluates per-feature against props.
          labelColorExpr = { ast: item.binding }
          continue
        }
        if (name === 'label-halo-color') {
          const stops = extractInterpolateZoomColorStops(item.binding)
          if (stops) {
            for (const s of stops) {
              const hex = resolveColor(s.value)
              if (hex) labelHaloColorZoomStops.push({ zoom: s.zoom, value: hexToRgba(hex) })
            }
            if (labelHaloColorZoomStops.length > 0) {
              labelHaloColor = labelHaloColorZoomStops[labelHaloColorZoomStops.length - 1]!.value
              continue
            }
          }
        }
        if (name === 'fill') {
          // Mapbox `paint.fill-color: ["interpolate", curve, ["zoom"], …]`
          // converts to `fill-[interpolate(zoom, z1, #hex, …)]`. The
          // converter emits hex literals at each stop; we extract them
          // into the zoom-interpolated ColorValue here. The runtime
          // (renderer.ts:render-loop) reads `zoomFillStops` if present
          // and recomputes the fill RGBA per frame from the camera
          // zoom. PR #97's earlier "last-stop only" heuristic collapsed
          // landuse-suburb to alpha=0 (Mapbox intentionally fades it
          // out at z=10) — every suburb polygon rendered invisible
          // regardless of viewing zoom; full preservation prevents
          // that regression class.
          const colorStops = extractInterpolateZoomColorStops(item.binding)
          if (colorStops && colorStops.length > 0) {
            const rgbaStops: ZoomStop<[number, number, number, number]>[] = []
            for (const s of colorStops) {
              const hex = resolveColor(s.value)
              if (hex) rgbaStops.push({ zoom: s.zoom, value: hexToRgba(hex) })
            }
            if (rgbaStops.length > 0) {
              fill = { kind: 'zoom-interpolated', stops: rgbaStops }
              continue
            }
          }
          // Per-feature `match(.field) { …, _ -> #color }` (Mapbox
          // `["match", ["get", "X"], …, default]`). Extract the
          // default arm as a constant fallback fill so the polygon
          // renders SOMETHING — without this, every country in the
          // MapLibre demo's `countries-fill` rendered as no-fill.
          // Per-feature distinct colours (the country-by-country
          // palette) await a `fillExpr` plumbing PR that threads the
          // full AST through ShowCommand for the worker to evaluate
          // per feature, mirroring the existing strokeColorExpr path.
          // The default-arm collapse is gated by
          // `LowerOptions.bypassExtractMatchDefaultColor` — when true
          // (P4 runtime opt-in), match() falls through to data-driven
          // even when an explicit `_` arm exists. The compute path
          // then evaluates every arm GPU-side.
          if (!options.bypassExtractMatchDefaultColor) {
            const defaultHex = extractMatchDefaultColor(item.binding)
            if (defaultHex) {
              const rgba = hexToRgba(defaultHex)
              fill = colorConstant(rgba[0], rgba[1], rgba[2], rgba[3])
              continue
            }
          }
          fill = { kind: 'data-driven', expr: { ast: item.binding } }
        } else if (name === 'stroke') {
          // `stroke-[<expr>]` carries either a colour expression (Mapbox
          // `paint.line-color: ["interpolate", …]`) or a width
          // expression (`paint.line-width: ["interpolate", …]`). The
          // converter emits the same shape for both because the
          // utility-name grammar can't tell them apart at the lex
          // stage. Disambiguate by inspecting the lowered expression:
          //   - `interpolate(zoom, z, color, …)`  → colour stops
          //   - `interpolate_exp(zoom, base, z, n, …)` → numeric stops
          //   - everything else → per-feature `widthExpr` (numeric
          //     case/match dominate; per-feature colour-only goes
          //     through `colorExpr` once that path lands).
          // Pre-fix this whole branch was missing — every OFM Bright
          // road's `stroke-[interpolate_exp(…)]` width silently
          // collapsed to the default 1 px, so the entire highway
          // network rendered as hair-thin lines.
          const colorStops = extractInterpolateZoomColorStops(item.binding)
          if (colorStops && colorStops.length > 0) {
            // Last stop is the constant fallback. ColorValue doesn't
            // (yet) have a `zoom-interpolated` variant for stroke; a
            // proper per-frame stroke colour update path is parallel
            // to the fill follow-up (see `name === 'fill'` arm).
            // For now picking the highest-zoom colour gives the right
            // appearance at typical viewing zoom and prevents the
            // silent null-stroke drop.
            const last = colorStops[colorStops.length - 1]!
            const hex = resolveColor(last.value)
            if (hex) {
              const rgba = hexToRgba(hex)
              strokeColor = colorConstant(rgba[0], rgba[1], rgba[2], rgba[3])
            }
          } else {
            // Disambiguate WIDTH vs COLOUR expression. Numeric zoom
            // stops (`interpolate_exp(zoom, base, z, n, …)` or
            // `interpolate(zoom, z, n, …)`) take the width path. A
            // colour-valued `match(.field) { v -> #rrggbb, …, _ ->
            // #default }` (Mapbox `paint.line-color: ["match", …]`)
            // walks the default-arm color extractor — if it yields a
            // hex, the binding is colour-shaped → route through the
            // strokeColorExpr field (mirror of the fill data-driven
            // arm above) so the runtime can evaluate per feature via
            // the line segment buffer's color_packed slot. Without
            // this branch a standalone data-driven stroke colour fell
            // straight through to `strokeWidthExpr`, the layer gained
            // no resolved colour, and dead-layer-elim dropped it.
            const widthStops = extractInterpolateZoomStops(item.binding)
            if (widthStops) {
              // Pure zoom-only width — hoist as zoom stops on the
              // stroke value. The renderer recomputes `layer.width_px`
              // per frame from camera.zoom, so the line widens
              // continuously as the user zooms (vs. the widthExpr
              // path which bakes a single width per tile at decode
              // time and only updates on tile-zoom boundary crosses).
              strokeWidthZoomStops = widthStops.stops
              strokeWidthZoomStopsBase = widthStops.base
            } else {
              const defaultHex = extractMatchDefaultColor(item.binding)
              if (defaultHex) {
                // Colour-shaped per-feature expression. Bake the
                // default arm as a constant fallback (so the layer
                // renders SOMETHING even before the per-feature
                // packer runs) and stash the full AST in
                // strokeColorExpr. Mirror of merge-layers' synthetic
                // strokeColorExpr emission.
                const rgba = hexToRgba(defaultHex)
                strokeColor = colorConstant(rgba[0], rgba[1], rgba[2], rgba[3])
                strokeColorExpr = { ast: item.binding }
              } else {
                // Per-feature `case` / `match` expression on width.
                strokeWidthExpr = { ast: item.binding }
              }
            }
          }
        } else if (name === 'size') {
          size = { kind: 'data-driven', expr: { ast: item.binding }, unit: item.bindingUnit ?? null }
        } else if (name === 'opacity') {
          opacity = { kind: 'data-driven', expr: { ast: item.binding } }
        } else if (name === 'fill-extrusion-height') {
          extrude = { kind: 'feature', expr: { ast: item.binding }, fallback: 0 }
        } else if (name === 'fill-extrusion-base') {
          extrudeBase = { kind: 'feature', expr: { ast: item.binding }, fallback: 0 }
        } else if (name === 'label') {
          // `label-[<expr>]` — text content for per-feature labels.
          // The runtime (TextStage) resolves the expression against
          // each feature's properties and emits per-glyph quads. The
          // 12-px size seed is a default; subsequent `label-size-N`
          // utilities override it before foldLabelKnobs.
          label = { text: bindingToTextValue(item.binding), size: 12 }
        } else {
          // Numeric label-* utilities that allow negative values use
          // bracket-binding form (`label-offset-y-[-0.2]`) since the
          // utility-name grammar treats `-` as a segment separator.
          // We only accept literal-number (or unary-minus literal)
          // bindings here — full data-driven offsets land later.
          const n = bindingAsConstantNumber(item.binding)
          if (n !== null) {
            if (name === 'label-offset-x') { labelOffsetX = n; continue }
            if (name === 'label-offset-y') { labelOffsetY = n; continue }
            if (name === 'label-translate-x') { labelTranslateX = n; continue }
            if (name === 'label-translate-y') { labelTranslateY = n; continue }
            if (name === 'label-radial-offset') { labelRadialOffset = n; continue }
            if (name.startsWith('label-vao-')) {
              // `label-vao-<idx>-<x|y>` bracket form (negative em).
              const m = /^label-vao-(\d+)-([xy])$/.exec(name)
              if (m) { setVao(parseInt(m[1]!, 10), m[2]!, n); continue }
            }
            if (name === 'label-rotate') { labelRotate = n; continue }
            if (name === 'label-letter-spacing') { labelLetterSpacing = n; continue }
            if (name === 'label-padding') { labelPadding = n; continue }
            // Bracket-binding form for negative icon-offset components.
            if (name === 'label-icon-offset-x') { labelIconOffset = [n, labelIconOffset?.[1] ?? 0]; continue }
            if (name === 'label-icon-offset-y') { labelIconOffset = [labelIconOffset?.[0] ?? 0, n]; continue }
            if (name === 'label-icon-rotate') { labelIconRotate = n; continue }
            if (name === 'label-icon-size') { labelIconSize = n; continue }
          }
          // Bracket-binding form with a name that's not in any of the
          // handled arms above (and not a recognised negative-numeric
          // label utility). Pre-fix this was the silent-drop hole that
          // hid the `stroke-[interpolate_exp(zoom, …)]` regression — a
          // `name: "stroke"` binding falls through every named handler
          // and gets dropped without a peep, so every Mapbox
          // `paint.line-width: ["interpolate", …]` reverted to a 1 px
          // hairline. Surface every unhandled binding as a warn-level
          // diagnostic so the next regression of this shape fails CI
          // instead of shipping silently.
          diagnostics.push({
            severity: 'warn',
            code: 'X-GIS0005',
            line: stmt.line,
            message:
              `Bracket-binding utility "${name}-[…]" has no handler in lower.ts — ` +
              `the expression is being dropped. Add a name==="${name}" arm in the ` +
              `binding-form handler to thread the value into the appropriate IR field.`,
          })
        }
        continue
      }

      // ── label-* visual knob utilities (Batch 1c-8g) ──
      // Folded into `label` at the bottom of the function. Order with
      // `label-[<expr>]` doesn't matter — these are just stored in
      // locals until assembly time.
      if (name === 'label-uppercase') { labelTransform = 'uppercase'; continue }
      if (name === 'label-lowercase') { labelTransform = 'lowercase'; continue }
      if (name === 'label-none') { labelTransform = 'none'; continue }
      if (name === 'label-allow-overlap') { labelAllowOverlap = true; continue }
      if (name === 'label-ignore-placement') { labelIgnorePlacement = true; continue }
      // Mapbox `symbol-placement: line | line-center` — labels follow
      // line geometry instead of anchoring at a point. Runtime walks
      // the line's segments and emits a label per feature with rotation
      // matching the local tangent.
      if (name === 'label-along-path') { labelPlacement = 'line'; continue }
      if (name === 'label-line-center') { labelPlacement = 'line-center'; continue }
      if (name === 'label-rotation-alignment-map') { labelRotationAlignment = 'map'; continue }
      if (name === 'label-rotation-alignment-viewport') { labelRotationAlignment = 'viewport'; continue }
      if (name === 'label-rotation-alignment-auto') { labelRotationAlignment = 'auto'; continue }
      if (name === 'label-pitch-alignment-map') { labelPitchAlignment = 'map'; continue }
      if (name === 'label-pitch-alignment-viewport') { labelPitchAlignment = 'viewport'; continue }
      if (name === 'label-pitch-alignment-auto') { labelPitchAlignment = 'auto'; continue }
      if (name === 'label-keep-upright-true') { labelKeepUpright = true; continue }
      if (name === 'label-keep-upright-false') { labelKeepUpright = false; continue }
      if (name === 'label-justify-auto') { labelJustify = 'auto'; continue }
      if (name === 'label-justify-left') { labelJustify = 'left'; continue }
      if (name === 'label-justify-center') { labelJustify = 'center'; continue }
      if (name === 'label-justify-right') { labelJustify = 'right'; continue }
      if (name.startsWith('label-anchor-')) {
        const a = name.slice('label-anchor-'.length)
        const valid = ['center', 'top', 'bottom', 'left', 'right',
          'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
        if ((valid as readonly string[]).includes(a)) {
          // First-seen wins for the static `anchor`; later siblings
          // become collision-fallback candidates. Avoid duplicates so
          // an accidental `label-anchor-top label-anchor-top` doesn't
          // bloat the candidate list.
          if (labelAnchor === undefined) labelAnchor = a as typeof valid[number]
          if (!labelAnchorCandidates.includes(a as typeof valid[number])) {
            labelAnchorCandidates.push(a as typeof valid[number])
          }
          continue
        }
      }
      if (name.startsWith('label-size-')) {
        const num = parseFloat(name.slice('label-size-'.length))
        if (!isNaN(num)) labelSize = num
        continue
      }
      if (name.startsWith('label-halo-color-')) {
        const hex = resolveColor(name.slice('label-halo-color-'.length))
        if (hex) labelHaloColor = hexToRgba(hex)
        continue
      }
      if (name.startsWith('label-halo-blur-')) {
        const num = parseFloat(name.slice('label-halo-blur-'.length))
        if (!isNaN(num)) labelHaloBlur = num
        continue
      }
      if (name.startsWith('label-halo-')) {
        const num = parseFloat(name.slice('label-halo-'.length))
        if (!isNaN(num)) labelHaloWidth = num
        continue
      }
      if (name.startsWith('label-color-')) {
        const hex = resolveColor(name.slice('label-color-'.length))
        if (hex) labelColor = hexToRgba(hex)
        continue
      }
      if (name.startsWith('label-offset-x-')) {
        const num = parseFloat(name.slice('label-offset-x-'.length))
        if (!isNaN(num)) labelOffsetX = num
        continue
      }
      if (name.startsWith('label-offset-y-')) {
        const num = parseFloat(name.slice('label-offset-y-'.length))
        if (!isNaN(num)) labelOffsetY = num
        continue
      }
      if (name.startsWith('label-translate-x-')) {
        const num = parseFloat(name.slice('label-translate-x-'.length))
        if (!isNaN(num)) labelTranslateX = num
        continue
      }
      if (name.startsWith('label-translate-y-')) {
        const num = parseFloat(name.slice('label-translate-y-'.length))
        if (!isNaN(num)) labelTranslateY = num
        continue
      }
      if (name.startsWith('label-padding-')) {
        const num = parseFloat(name.slice('label-padding-'.length))
        if (!isNaN(num)) labelPadding = num
        continue
      }
      if (name.startsWith('label-radial-offset-')) {
        const num = parseFloat(name.slice('label-radial-offset-'.length))
        if (!isNaN(num)) labelRadialOffset = num
        continue
      }
      if (name.startsWith('label-vao-')) {
        // `label-vao-<idx>-<x|y>-<n>` (positive em; negatives use the
        // bracket-binding form handled above).
        const m = /^label-vao-(\d+)-([xy])-(.+)$/.exec(name)
        if (m) {
          const num = parseFloat(m[3]!)
          if (!isNaN(num)) setVao(parseInt(m[1]!, 10), m[2]!, num)
        }
        continue
      }
      if (name.startsWith('label-rotate-')) {
        const num = parseFloat(name.slice('label-rotate-'.length))
        if (!isNaN(num)) labelRotate = num
        continue
      }
      if (name.startsWith('label-letter-spacing-')) {
        const num = parseFloat(name.slice('label-letter-spacing-'.length))
        if (!isNaN(num)) labelLetterSpacing = num
        continue
      }
      if (name.startsWith('label-max-width-')) {
        const num = parseFloat(name.slice('label-max-width-'.length))
        if (!isNaN(num)) labelMaxWidth = num
        continue
      }
      if (name.startsWith('label-line-height-')) {
        const num = parseFloat(name.slice('label-line-height-'.length))
        if (!isNaN(num)) labelLineHeight = num
        continue
      }
      // ── Icon (Batch 2 — sprite atlas) ──
      // Mapbox `icon-image` (constant string only for now). The
      // utility carries the raw atlas key; downstream IconStage looks
      // it up in the sprite metadata on draw.
      if (name.startsWith('label-icon-image-')) {
        labelIconImage = name.slice('label-icon-image-'.length)
        continue
      }
      if (name.startsWith('label-icon-size-')) {
        const num = parseFloat(name.slice('label-icon-size-'.length))
        if (!isNaN(num)) labelIconSize = num
        continue
      }
      if (name.startsWith('label-icon-anchor-')) {
        const a = name.slice('label-icon-anchor-'.length)
        const valid = ['center', 'top', 'bottom', 'left', 'right',
          'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
        if ((valid as readonly string[]).includes(a)) {
          labelIconAnchor = a as typeof valid[number]
        }
        continue
      }
      if (name.startsWith('label-icon-offset-x-')) {
        const num = parseFloat(name.slice('label-icon-offset-x-'.length))
        if (!isNaN(num)) labelIconOffset = [num, labelIconOffset?.[1] ?? 0]
        continue
      }
      if (name.startsWith('label-icon-offset-y-')) {
        const num = parseFloat(name.slice('label-icon-offset-y-'.length))
        if (!isNaN(num)) labelIconOffset = [labelIconOffset?.[0] ?? 0, num]
        continue
      }
      if (name.startsWith('label-icon-rotate-')) {
        const num = parseFloat(name.slice('label-icon-rotate-'.length))
        if (!isNaN(num)) labelIconRotate = num
        continue
      }
      if (name.startsWith('label-spacing-')) {
        const num = parseFloat(name.slice('label-spacing-'.length))
        if (!isNaN(num)) labelSpacing = num
        continue
      }
      if (name.startsWith('label-font-weight-')) {
        // Numeric CSS weight (100..900). The converter normalises
        // Mapbox's word suffixes — "Bold" → 700, "Light" → 300, etc.
        // Hand-authored xgis can also write `label-font-weight-500`
        // for medium without going through the converter.
        const num = parseFloat(name.slice('label-font-weight-'.length))
        if (!isNaN(num)) labelFontWeight = num
        continue
      }
      if (name === 'label-italic') {
        // Boolean utility — presence sets italic. The runtime composes
        // ctx.font with `italic` as the CSS style prefix so the browser
        // selects the italic face from the OS. Spelled `label-italic`
        // (not `label-font-style-italic`) because `style` is reserved
        // for the top-level `style { … }` block grammar.
        labelFontStyle = 'italic'
        continue
      }
      if (name.startsWith('label-font-')) {
        // Each `label-font-X` utility APPENDS one font to the
        // fallback stack. Spaces in Mapbox font names round-trip
        // via `-`. Stack form (multiple utilities):
        //   | label-font-Noto-Sans label-font-Noto-Sans-CJK
        // The runtime feeds the whole stack to ctx.font as a
        // comma-separated CSS font value so the browser handles
        // glyph-by-glyph fallback automatically (Latin glyphs from
        // the first font, CJK from the second when the first lacks
        // them). Weight/italic words used to live IN this name; they
        // now ride `label-font-weight-N` / `label-font-style-X` so
        // ctx.font can apply them via CSS shorthand instead of as
        // part of the family token.
        const raw = name.slice('label-font-'.length)
        const restored = raw.replace(/-/g, ' ')
        if (restored.length > 0) {
          if (!labelFontStack) labelFontStack = []
          labelFontStack.push(restored)
        }
        continue
      }

      // Catch-all safety net for unrecognised `label-*` utilities,
      // mirroring the bracket-binding X-GIS0005 guard. Every handled
      // label utility above `continue`s; anything that starts with
      // `label-` and reaches here had NO parsing arm, so the converter
      // emitted a value that lower.ts silently drops — the exact
      // failure mode of the text-variable-anchor regression (converter
      // emitted `label-anchor-*`, but for the real layout property the
      // emission was missing entirely). Surface it as a warn so a
      // future converter/lower mismatch fails CI instead of shipping a
      // silently-ignored knob. (Malformed values like an invalid
      // `label-anchor-<x>` also land here — equally worth flagging.)
      if (name.startsWith('label-')) {
        diagnostics.push({
          severity: 'warn',
          code: 'X-GIS0006',
          line: stmt.line,
          message:
            `Label utility "${name}" has no handler in lower.ts — the ` +
            `value is being dropped. Add a matching arm in the label-` +
            `utility parser so the converter's emission threads into ` +
            `LabelDef.`,
        })
        continue
      }

      if (name.startsWith('fill-extrusion-height-')) {
        // Mapbox `fill-extrusion-height` paint property as a tailwind-
        // shaped utility. Value is a static metres count; data-driven
        // form is handled higher up via the `-[expr]` binding branch.
        const num = parseFloat(name.slice('fill-extrusion-height-'.length))
        if (!isNaN(num)) extrude = { kind: 'constant', value: num }
      } else if (name.startsWith('fill-extrusion-base-')) {
        // Mapbox `fill-extrusion-base` paint property — z of the
        // wall BOTTOM (default 0). Combined with the height utility
        // it carves out a `min_height`-style podium for tall
        // buildings. Static-value form; data-driven goes through
        // the `-[expr]` branch above.
        const num = parseFloat(name.slice('fill-extrusion-base-'.length))
        if (!isNaN(num)) extrudeBase = { kind: 'constant', value: num }
      } else if (name.startsWith('fill-')) {
        const hex = resolveColor(name.slice(5))
        if (hex) fill = colorConstant(...hexToRgba(hex))
      } else if (name === 'stroke-butt-cap') {
        linecap = 'butt'
      } else if (name === 'stroke-round-cap') {
        linecap = 'round'
      } else if (name === 'stroke-square-cap') {
        linecap = 'square'
      } else if (name === 'stroke-arrow-cap') {
        linecap = 'arrow'
      } else if (name === 'stroke-miter-join') {
        linejoin = 'miter'
      } else if (name === 'stroke-round-join') {
        linejoin = 'round'
      } else if (name === 'stroke-bevel-join') {
        linejoin = 'bevel'
      } else if (name.startsWith('stroke-miterlimit-')) {
        const num = parseFloat(name.slice('stroke-miterlimit-'.length))
        if (!isNaN(num)) miterlimit = num
      } else if (name.startsWith('stroke-dasharray-')) {
        // e.g. stroke-dasharray-10-5 or stroke-dasharray-6-2-1-2.
        // The lexer splits `20_10` into Number + Identifier which breaks
        // the utility-name accumulator — hyphen is the only separator that
        // stays inside a single utility token via parseUtilityName.
        const parts = name.slice('stroke-dasharray-'.length).split('-')
        const nums = parts.map(parseFloat).filter(n => !isNaN(n))
        if (nums.length >= 2) dashArray = nums
      } else if (name.startsWith('stroke-dashoffset-')) {
        const num = parseFloat(name.slice('stroke-dashoffset-'.length))
        if (!isNaN(num)) dashOffset = num
      } else if (name === 'stroke-inset') {
        // GDI+-style alignment: shift the centerline inward by half the
        // stroke width so the stroke sits entirely on the left of travel.
        // Resolved at runtime against the current strokeWidth.
        strokeAlign = 'inset'
      } else if (name === 'stroke-outset') {
        strokeAlign = 'outset'
      } else if (name === 'stroke-center') {
        strokeAlign = 'center'
      } else if (name.startsWith('stroke-offset-right-')) {
        // Right-hand parallel offset: same magnitude, negative sign convention.
        const num = parseFloat(name.slice('stroke-offset-right-'.length))
        if (!isNaN(num)) strokeOffset = -num
      } else if (name.startsWith('stroke-offset-left-')) {
        const num = parseFloat(name.slice('stroke-offset-left-'.length))
        if (!isNaN(num)) strokeOffset = num
      } else if (name.startsWith('stroke-offset-')) {
        // Bare stroke-offset-N → positive (left of travel) by default.
        const num = parseFloat(name.slice('stroke-offset-'.length))
        if (!isNaN(num)) strokeOffset = num
      } else if (name.startsWith('stroke-pattern-1-')) {
        parsePatternAttr(name.slice('stroke-pattern-1-'.length), 1)
      } else if (name.startsWith('stroke-pattern-2-')) {
        parsePatternAttr(name.slice('stroke-pattern-2-'.length), 2)
      } else if (name.startsWith('stroke-pattern-')) {
        parsePatternAttr(name.slice('stroke-pattern-'.length), 0)
      } else if (name.startsWith('stroke-blur-')) {
        // Mapbox `paint.line-blur` — edge feathering in CSS px.
        const num = parseFloat(name.slice('stroke-blur-'.length))
        if (!isNaN(num)) strokeBlur = num
      } else if (name.startsWith('stroke-')) {
        const rest = name.slice(7)
        const num = parseFloat(rest)
        if (!isNaN(num) && rest === String(num)) {
          strokeWidth = num
        } else {
          const hex = resolveColor(rest)
          if (hex) strokeColor = colorConstant(...hexToRgba(hex))
        }
      } else if (name.startsWith('opacity-')) {
        const num = parseFloat(name.slice(8))
        if (!isNaN(num)) {
          const val = num <= 1 ? num : num / 100
          opacity = opacityConstant(val)
        }
      } else if (name.startsWith('size-')) {
        const sizeStr = name.slice(5)
        const unitMatch = sizeStr.match(/^([\d.]+)(px|m|km|nm|deg)?$/)
        if (unitMatch) {
          const num = parseFloat(unitMatch[1])
          const unit = unitMatch[2] || null  // null = px default
          if (!isNaN(num)) size = sizeConstant(num, unit)
        }
      } else if (name.startsWith('projection-')) {
        projection = name.slice(11)
      } else if (name === 'hidden') {
        visible = false
      } else if (name === 'flat') {
        billboard = false
      } else if (name === 'billboard') {
        billboard = true
      } else if (name === 'anchor-center') {
        anchor = 'center'
      } else if (name === 'anchor-bottom') {
        anchor = 'bottom'
      } else if (name === 'anchor-top') {
        anchor = 'top'
      } else if (name.startsWith('shape-')) {
        const shapeName = name.slice(6)
        if (item.binding) {
          shape = { kind: 'data-driven', expr: { ast: item.binding } }
        } else {
          shape = { kind: 'named', name: shapeName }
        }
      } else if (name === 'visible') {
        visible = true
      } else if (name === 'pointer-events-none') {
        pointerEvents = 'none'
      } else if (name === 'pointer-events-auto') {
        pointerEvents = 'auto'
      } else if (name.startsWith('animation-')) {
        // All animation-related utilities carry the `animation-` prefix so
        // they're visually grouped and can't collide with non-animation
        // modifiers. The sub-prefix discriminator decides whether this is
        // a lifecycle setting or a keyframes reference:
        //
        //   animation-duration-<ms>   → duration in milliseconds
        //   animation-delay-<ms>      → delay in ms (negative allowed)
        //   animation-ease-{linear|in|out|in-out}
        //                             → easing function
        //   animation-infinite        → loop forever (PR 2 will add
        //                               animation-iteration-<N> for finite)
        //   animation-<anything else> → keyframes reference by name
        //
        // This means `duration`, `delay`, `ease-*`, and `infinite` are
        // reserved as keyframes names — using them in `keyframes <name>`
        // makes them unreachable here.
        const rest = name.slice('animation-'.length)
        if (rest.startsWith('duration-')) {
          const num = parseFloat(rest.slice('duration-'.length))
          if (!isNaN(num)) animationDurationMs = num
        } else if (rest.startsWith('delay-')) {
          const num = parseFloat(rest.slice('delay-'.length))
          if (!isNaN(num)) animationDelayMs = num
        } else if (rest === 'ease-linear') {
          animationEasing = 'linear'
        } else if (rest === 'ease-in') {
          animationEasing = 'ease-in'
        } else if (rest === 'ease-out') {
          animationEasing = 'ease-out'
        } else if (rest === 'ease-in-out') {
          animationEasing = 'ease-in-out'
        } else if (rest === 'infinite') {
          animationLoop = true
        } else {
          animationName = rest
        }
      }
    }
  }

  // Expand referenced keyframes into per-property time stops.
  //
  // PR 1 covered opacity. PR 3 (this code) covers fill, stroke color,
  // stroke width, point size, and stroke dash-offset — the five
  // properties that already have concrete per-layer uniform slots.
  // PR 5 will add transforms, PR 6 filters.
  const opacityTimeStops: TimeStop<number>[] = []
  const fillTimeStops: TimeStop<[number, number, number, number]>[] = []
  const strokeColorTimeStops: TimeStop<[number, number, number, number]>[] = []
  const strokeWidthTimeStops: TimeStop<number>[] = []
  const sizeTimeStops: TimeStop<number>[] = []
  const dashOffsetTimeStops: TimeStop<number>[] = []
  if (animationName) {
    const kf = keyframesMap.get(animationName)
    if (!kf) {
      throw new Error(
        `Unknown keyframes reference: animation-${animationName} ` +
        `(layer '${stmt.name}' at line ${stmt.line})`,
      )
    }
    for (const frame of kf.frames) {
      const timeMs = (frame.percent / 100) * animationDurationMs
      for (const item of frame.utilities) {
        const uname = item.name
        // ── opacity ──
        if (uname.startsWith('opacity-')) {
          const num = parseFloat(uname.slice('opacity-'.length))
          if (!isNaN(num)) {
            opacityTimeStops.push({
              timeMs,
              value: num <= 1 ? num : num / 100,
            })
          }
          continue
        }
        // ── dash-offset (meters) ──
        // Must come before the generic `stroke-` branch because
        // `stroke-dashoffset-N` shares the prefix.
        if (uname.startsWith('stroke-dashoffset-')) {
          const num = parseFloat(uname.slice('stroke-dashoffset-'.length))
          if (!isNaN(num)) dashOffsetTimeStops.push({ timeMs, value: num })
          continue
        }
        // ── fill color ──
        if (uname.startsWith('fill-')) {
          const hex = resolveColor(uname.slice('fill-'.length))
          if (hex) fillTimeStops.push({ timeMs, value: hexToRgba(hex) })
          continue
        }
        // ── stroke: either color or width ──
        // The existing static lowering treats `stroke-<number>` as
        // width and `stroke-<colorname>` as color. Mirror that here.
        if (uname.startsWith('stroke-')) {
          const rest = uname.slice('stroke-'.length)
          const num = parseFloat(rest)
          if (!isNaN(num) && rest === String(num)) {
            strokeWidthTimeStops.push({ timeMs, value: num })
          } else {
            const hex = resolveColor(rest)
            if (hex) strokeColorTimeStops.push({ timeMs, value: hexToRgba(hex) })
          }
          continue
        }
        // ── point size ──
        if (uname.startsWith('size-')) {
          const sizeStr = uname.slice('size-'.length)
          const unitMatch = sizeStr.match(/^([\d.]+)(px|m|km|nm|deg)?$/)
          if (unitMatch) {
            const num = parseFloat(unitMatch[1])
            if (!isNaN(num)) sizeTimeStops.push({ timeMs, value: num })
          }
          continue
        }
        // Unknown keyframe utilities are silently ignored. Future PRs
        // extend this loop (transforms, filters, etc.).
      }
    }
  }

  // Build conditional fill if branches exist
  if (fillBranches.length > 0) {
    fill = { kind: 'conditional', branches: fillBranches, fallback: fill }
  }

  // Build opacity — may be zoom-interpolated, time-interpolated, or a
  // zoom-time hybrid when a layer carries BOTH `z<N>:opacity-*` and
  // `animation-*`. The runtime composes the two multiplicatively.
  if (opacityTimeStops.length > 0) {
    opacityTimeStops.sort((a, b) => a.timeMs - b.timeMs)
    if (opacityZoomStops.length > 0) {
      opacityZoomStops.sort((a, b) => a.zoom - b.zoom)
      opacity = {
        kind: 'zoom-time',
        zoomStops: opacityZoomStops,
        timeStops: opacityTimeStops,
        loop: animationLoop,
        easing: animationEasing,
        delayMs: animationDelayMs,
      }
    } else {
      opacity = {
        kind: 'time-interpolated',
        stops: opacityTimeStops,
        loop: animationLoop,
        easing: animationEasing,
        delayMs: animationDelayMs,
      }
    }
  } else if (opacityZoomStops.length > 0) {
    opacityZoomStops.sort((a, b) => a.zoom - b.zoom)
    opacity = {
      kind: 'zoom-interpolated',
      stops: opacityZoomStops,
      ...(opacityZoomStopsBase !== undefined ? { base: opacityZoomStopsBase } : {}),
    }
  }

  // ── PR 3: build animated fill/stroke/width/size/dashOffset ──
  //
  // Each list is only promoted if the keyframe block actually set the
  // corresponding property at ≥2 frames. A single stop wouldn't animate
  // anything — we'd just hold that value forever — so that case
  // degenerates to a constant and we skip the promotion.

  if (fillTimeStops.length >= 2) {
    fillTimeStops.sort((a, b) => a.timeMs - b.timeMs)
    // `base` is the fill color the layer had before keyframes touched
    // it, so pre-animation frames still look right. If the layer had no
    // explicit fill, fall back to the first stop's value.
    const baseRgba: import('./property-types').RGBA =
      fill.kind === 'constant' ? fill.rgba : fillTimeStops[0].value
    fill = {
      kind: 'time-interpolated',
      base: baseRgba,
      stops: fillTimeStops,
      loop: animationLoop,
      easing: animationEasing,
      delayMs: animationDelayMs,
    }
  }

  if (strokeColorTimeStops.length >= 2) {
    strokeColorTimeStops.sort((a, b) => a.timeMs - b.timeMs)
    const baseRgba: import('./property-types').RGBA =
      strokeColor.kind === 'constant' ? strokeColor.rgba : strokeColorTimeStops[0].value
    strokeColor = {
      kind: 'time-interpolated',
      base: baseRgba,
      stops: strokeColorTimeStops,
      loop: animationLoop,
      easing: animationEasing,
      delayMs: animationDelayMs,
    }
  }

  // Width / dashOffset live as parallel time stop lists on StrokeValue,
  // stamped after the stroke object is built below. We hold them in
  // outer-scope let variables here and read them below.
  if (strokeWidthTimeStops.length >= 2) {
    strokeWidthTimeStops.sort((a, b) => a.timeMs - b.timeMs)
  }
  if (dashOffsetTimeStops.length >= 2) {
    dashOffsetTimeStops.sort((a, b) => a.timeMs - b.timeMs)
  }

  if (sizeTimeStops.length >= 2) {
    sizeTimeStops.sort((a, b) => a.timeMs - b.timeMs)
    const baseUnit =
      (size.kind === 'constant' || size.kind === 'data-driven') ? (size.unit ?? null) : null
    size = {
      kind: 'time-interpolated',
      stops: sizeTimeStops,
      loop: animationLoop,
      easing: animationEasing,
      delayMs: animationDelayMs,
      unit: baseUnit,
    }
  }

  // Build zoom-interpolated size if stops exist
  if (sizeZoomStops.length > 0) {
    sizeZoomStops.sort((a, b) => a.zoom - b.zoom)
    size = {
      kind: 'zoom-interpolated',
      stops: sizeZoomStops,
      ...(sizeZoomStopsBase !== undefined ? { base: sizeZoomStopsBase } : {}),
    }
  }

  // Mapbox `text-variable-anchor-offset`: zip the i-th emitted anchor
  // candidate with the i-th `label-vao-*` offset pair. Only built when
  // the converter actually emitted vao pairs — plain text-variable-
  // anchor / text-radial-offset leave this undefined and the runtime
  // falls back to the radial / text-offset path.
  const labelVariableAnchorOffset = labelVao.length > 0
    ? labelAnchorCandidates
        .slice(0, labelVao.length)
        .map((a, i) => [a, labelVao[i] ?? [0, 0]] as [
          typeof a, [number, number],
        ])
    : undefined

  return {
    name: stmt.name,
    sourceRef,
    sourceLayer,
    zOrder,
    minzoom,
    maxzoom,
    fill,
    stroke: (() => {
      const validPatterns = patternSlots.filter((p, i) =>
        patternDirty[i] && p.shape && p.size > 0 && (p.spacing > 0 || p.anchor !== 'repeat' && p.anchor !== undefined)
      )
      // Resolve the three local accumulators into a single
      // discriminated union. Priority — per-feature AST wins over
      // zoom stops, which win over the static constant — mirrors the
      // runtime resolution order (worker bake > per-frame stops >
      // layer uniform).
      let widthSource: import('./render-node').StrokeWidthValue
      if (strokeWidthExpr !== undefined) {
        widthSource = { kind: 'data-driven', expr: strokeWidthExpr }
      } else if (strokeWidthZoomStops !== undefined && strokeWidthZoomStops.length > 0) {
        widthSource = strokeWidthZoomStopsBase !== undefined
          ? { kind: 'zoom-interpolated', stops: strokeWidthZoomStops, base: strokeWidthZoomStopsBase }
          : { kind: 'zoom-interpolated', stops: strokeWidthZoomStops }
      } else {
        widthSource = { kind: 'constant', value: strokeWidth }
      }
      return {
        color: strokeColor,
        width: widthSource,
        ...(strokeColorExpr !== undefined ? { colorExpr: strokeColorExpr } : {}),
        linecap, linejoin, miterlimit,
        dashArray, dashOffset,
        patterns: validPatterns.length > 0 ? validPatterns : undefined,
        offset: strokeOffset,
        align: strokeAlign,
        blur: strokeBlur,
        timeWidthStops: strokeWidthTimeStops.length >= 2 ? strokeWidthTimeStops : undefined,
        timeDashOffsetStops: dashOffsetTimeStops.length >= 2 ? dashOffsetTimeStops : undefined,
      }
    })(),
    animationMeta: animationName
      ? { loop: animationLoop, easing: animationEasing, delayMs: animationDelayMs }
      : undefined,
    opacity,
    size,
    projection,
    visible,
    pointerEvents,
    filter: filterExpr ? { ast: filterExpr } : null,
    geometry: geometryExpr ? { ast: geometryExpr } : null,
    billboard,
    shape,
    anchor,
    extrude,
    extrudeBase,
    label: foldLabelKnobs(label, {
      labelSize, labelColor, labelHaloWidth, labelHaloColor, labelHaloBlur,
      labelAnchor, labelTransform, labelOffsetX, labelOffsetY,
      labelTranslateX, labelTranslateY, labelRadialOffset,
      labelVariableAnchorOffset,
      labelSizeZoomStops: labelSizeZoomStops.length > 0 ? labelSizeZoomStops : undefined,
      labelSizeZoomStopsBase,
      labelColorZoomStops: labelColorZoomStops.length > 0 ? labelColorZoomStops : undefined,
      labelColorExpr, labelSizeExpr,
      labelAnchorCandidates: labelAnchorCandidates.length > 1 ? labelAnchorCandidates : undefined,
      labelHaloWidthZoomStops: labelHaloWidthZoomStops.length > 0 ? labelHaloWidthZoomStops : undefined,
      labelHaloWidthZoomStopsBase,
      labelHaloColorZoomStops: labelHaloColorZoomStops.length > 0 ? labelHaloColorZoomStops : undefined,
      labelAllowOverlap, labelIgnorePlacement, labelPadding,
      labelRotate, labelLetterSpacing, labelFontStack, labelFontWeight, labelFontStyle,
      labelMaxWidth, labelLineHeight, labelJustify,
      labelPlacement, labelSpacing,
      labelRotationAlignment, labelPitchAlignment, labelKeepUpright,
      labelIconImage, labelIconSize, labelIconAnchor, labelIconOffset, labelIconRotate,
    }),
  }
}

/** Merge sibling `label-*` utility values into the LabelDef built
 *  from `label-[<expr>]`. Returns the input unchanged when no knobs
 *  are present (covers the common one-utility-only case). When knobs
 *  exist but the layer has no `label-[<expr>]`, returns undefined —
 *  visual knobs without a text source produce no rendering and the
 *  warning is the user's responsibility (the converter surfaces it). */
function foldLabelKnobs(
  base: import('./render-node').LabelDef | undefined,
  knobs: {
    labelSize?: number
    labelColor?: [number, number, number, number]
    labelHaloWidth?: number
    labelHaloColor?: [number, number, number, number]
    labelHaloBlur?: number
    labelAnchor?: import('./render-node').LabelDef['anchor']
    labelAnchorCandidates?: import('./render-node').LabelDef['anchorCandidates']
    labelTransform?: import('./render-node').LabelDef['transform']
    labelOffsetX?: number
    labelOffsetY?: number
    labelTranslateX?: number
    labelTranslateY?: number
    labelRadialOffset?: number
    labelVariableAnchorOffset?: import('./render-node').LabelDef['variableAnchorOffset']
    labelSizeZoomStops?: ZoomStop<number>[]
    /** Mapbox `["exponential", N]` curve base for the size stops.
     *  Undefined / 1 → linear; >1 → faster growth at higher zooms. */
    labelSizeZoomStopsBase?: number
    labelColorZoomStops?: ZoomStop<[number, number, number, number]>[]
    labelColorExpr?: import('./render-node').DataExpr
    labelSizeExpr?: import('./render-node').DataExpr
    labelHaloWidthZoomStops?: ZoomStop<number>[]
    labelHaloWidthZoomStopsBase?: number
    labelHaloColorZoomStops?: ZoomStop<[number, number, number, number]>[]
    labelAllowOverlap?: boolean
    labelIgnorePlacement?: boolean
    labelPadding?: number
    labelRotate?: number
    labelLetterSpacing?: number
    labelFontStack?: string[]
    labelFontWeight?: number
    labelFontStyle?: 'normal' | 'italic'
    labelMaxWidth?: number
    labelLineHeight?: number
    labelJustify?: 'auto' | 'left' | 'center' | 'right'
    labelPlacement?: 'point' | 'line' | 'line-center'
    labelSpacing?: number
    labelRotationAlignment?: 'map' | 'viewport' | 'auto'
    labelPitchAlignment?: 'map' | 'viewport' | 'auto'
    labelKeepUpright?: boolean
    labelIconImage?: string
    labelIconSize?: number
    labelIconAnchor?: import('./render-node').LabelDef['iconAnchor']
    labelIconOffset?: [number, number]
    labelIconRotate?: number
  },
): import('./render-node').LabelDef | undefined {
  if (!base) return undefined
  let halo = base.halo
  if (knobs.labelHaloWidth !== undefined
      || knobs.labelHaloColor !== undefined
      || knobs.labelHaloBlur !== undefined) {
    const resolvedBlur = knobs.labelHaloBlur ?? base.halo?.blur
    halo = {
      // Mapbox `text-halo-color` default is `rgba(0,0,0,0)` (transparent
      // black). Stops at this fallback should NOT paint a visible halo —
      // pre-fix the [0,0,0,1] (opaque black) default rendered a hard black
      // outline around every label that declared `text-halo-width: N` but
      // omitted `text-halo-color`. Most visible on OFM Bright at z > 12.2
      // where `highway-name-major` first appears: grey #666 text got
      // smothered by an opaque black halo.
      color: knobs.labelHaloColor ?? base.halo?.color ?? [0, 0, 0, 0],
      width: knobs.labelHaloWidth ?? base.halo?.width ?? 1,
      ...(resolvedBlur !== undefined ? { blur: resolvedBlur } : {}),
    }
  }
  let offset = base.offset
  if (knobs.labelOffsetX !== undefined || knobs.labelOffsetY !== undefined) {
    offset = [
      knobs.labelOffsetX ?? base.offset?.[0] ?? 0,
      knobs.labelOffsetY ?? base.offset?.[1] ?? 0,
    ]
  }
  let translate = base.translate
  if (knobs.labelTranslateX !== undefined || knobs.labelTranslateY !== undefined) {
    translate = [
      knobs.labelTranslateX ?? base.translate?.[0] ?? 0,
      knobs.labelTranslateY ?? base.translate?.[1] ?? 0,
    ]
  }
  const merged: import('./render-node').LabelDef = {
    ...base,
    ...(knobs.labelSize !== undefined ? { size: knobs.labelSize } : {}),
    ...(knobs.labelColor !== undefined ? { color: knobs.labelColor } : {}),
    ...(halo !== undefined ? { halo } : {}),
    ...(knobs.labelAnchor !== undefined ? { anchor: knobs.labelAnchor } : {}),
    ...(knobs.labelAnchorCandidates !== undefined ? { anchorCandidates: knobs.labelAnchorCandidates } : {}),
    ...(knobs.labelTransform !== undefined ? { transform: knobs.labelTransform } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(translate !== undefined ? { translate } : {}),
    ...(knobs.labelRadialOffset !== undefined ? { radialOffset: knobs.labelRadialOffset } : {}),
    ...(knobs.labelVariableAnchorOffset !== undefined && knobs.labelVariableAnchorOffset.length > 0
      ? { variableAnchorOffset: knobs.labelVariableAnchorOffset } : {}),
    ...(knobs.labelAllowOverlap !== undefined ? { allowOverlap: knobs.labelAllowOverlap } : {}),
    ...(knobs.labelIgnorePlacement !== undefined ? { ignorePlacement: knobs.labelIgnorePlacement } : {}),
    ...(knobs.labelPadding !== undefined ? { padding: knobs.labelPadding } : {}),
    ...(knobs.labelRotate !== undefined ? { rotate: knobs.labelRotate } : {}),
    ...(knobs.labelLetterSpacing !== undefined ? { letterSpacing: knobs.labelLetterSpacing } : {}),
    ...(knobs.labelFontStack !== undefined && knobs.labelFontStack.length > 0
      ? { font: knobs.labelFontStack } : {}),
    ...(knobs.labelFontWeight !== undefined ? { fontWeight: knobs.labelFontWeight } : {}),
    ...(knobs.labelFontStyle !== undefined ? { fontStyle: knobs.labelFontStyle } : {}),
    ...(knobs.labelMaxWidth !== undefined ? { maxWidth: knobs.labelMaxWidth } : {}),
    ...(knobs.labelLineHeight !== undefined ? { lineHeight: knobs.labelLineHeight } : {}),
    ...(knobs.labelJustify !== undefined ? { justify: knobs.labelJustify } : {}),
    ...(knobs.labelPlacement !== undefined ? { placement: knobs.labelPlacement } : {}),
    ...(knobs.labelSpacing !== undefined ? { spacing: knobs.labelSpacing } : {}),
    ...(knobs.labelRotationAlignment !== undefined ? { rotationAlignment: knobs.labelRotationAlignment } : {}),
    ...(knobs.labelPitchAlignment !== undefined ? { pitchAlignment: knobs.labelPitchAlignment } : {}),
    ...(knobs.labelKeepUpright !== undefined ? { keepUpright: knobs.labelKeepUpright } : {}),
    // Batch 2 — sprite icon fields
    ...(knobs.labelIconImage !== undefined ? { iconImage: knobs.labelIconImage } : {}),
    ...(knobs.labelIconSize !== undefined ? { iconSize: knobs.labelIconSize } : {}),
    ...(knobs.labelIconAnchor !== undefined ? { iconAnchor: knobs.labelIconAnchor } : {}),
    ...(knobs.labelIconOffset !== undefined ? { iconOffset: knobs.labelIconOffset } : {}),
    ...(knobs.labelIconRotate !== undefined ? { iconRotate: knobs.labelIconRotate } : {}),
  }
  // Plan Label L3: the LabelDef no longer carries `xxxZoomStops` /
  // `xxxExpr` siblings — those were dead-staging fields. Build the
  // unified shapes bundle from the knob inputs (the actual source
  // of the data) + the merged label's static fallbacks.
  merged.shapes = buildLabelShapes({
    size: merged.size,
    sizeZoomStops: knobs.labelSizeZoomStops && knobs.labelSizeZoomStops.length > 0
      ? knobs.labelSizeZoomStops : undefined,
    sizeZoomStopsBase: knobs.labelSizeZoomStopsBase,
    sizeExpr: knobs.labelSizeExpr,
    color: merged.color,
    colorZoomStops: knobs.labelColorZoomStops && knobs.labelColorZoomStops.length > 0
      ? knobs.labelColorZoomStops : undefined,
    colorExpr: knobs.labelColorExpr,
    halo: merged.halo,
    haloWidthZoomStops: knobs.labelHaloWidthZoomStops && knobs.labelHaloWidthZoomStops.length > 0
      ? knobs.labelHaloWidthZoomStops : undefined,
    haloWidthZoomStopsBase: knobs.labelHaloWidthZoomStopsBase,
    haloColorZoomStops: knobs.labelHaloColorZoomStops && knobs.labelHaloColorZoomStops.length > 0
      ? knobs.labelHaloColorZoomStops : undefined,
    fontStack: merged.font,
    fontWeight: merged.fontWeight,
    fontStyle: merged.fontStyle,
  })
  return merged
}

/**
 * Apply CSS-like style properties to rendering values.
 * Resolves color names (via Tailwind palette), hex colors, and numbers.
 */
function applyStyleProperties(
  props: AST.StyleProperty[],
  fill: ColorValue,
  strokeColor: ColorValue,
  strokeWidth: number,
  opacity: OpacityValue,
  projection: string,
  visible: boolean,
): {
  fill: ColorValue
  strokeColor: ColorValue
  strokeWidth: number
  opacity: OpacityValue
  projection: string
  visible: boolean
  linecap?: 'butt' | 'round' | 'square' | 'arrow'
  linejoin?: 'miter' | 'round' | 'bevel'
  miterlimit?: number
  dashArray?: number[]
  dashOffset?: number
  strokeOffset?: number
  strokeAlign?: 'center' | 'inset' | 'outset'
  pattern?: import('./render-node').StrokePattern
} {
  let linecap: 'butt' | 'round' | 'square' | 'arrow' | undefined
  let linejoin: 'miter' | 'round' | 'bevel' | undefined
  let miterlimit: number | undefined
  let dashArray: number[] | undefined
  let dashOffset: number | undefined
  let strokeOffset: number | undefined
  let strokeAlign: 'center' | 'inset' | 'outset' | undefined
  const pattern: import('./render-node').StrokePattern = { shape: '', spacing: 0, size: 0 }
  let patternDirtyCss = false
  const parseCssUnitValue = (v: string): { num: number; unit: 'm' | 'px' | 'km' | 'nm' } | null => {
    const m = v.trim().match(/^(-?[\d.]+)\s*(m|px|km|nm)?$/)
    if (!m) return null
    return { num: parseFloat(m[1]), unit: (m[2] as 'm' | 'px' | 'km' | 'nm' | undefined) ?? 'm' }
  }
  for (const prop of props) {
    switch (prop.name) {
      case 'fill': {
        const hex = resolveColor(prop.value) ?? (prop.value.startsWith('#') ? prop.value : null)
        if (hex) fill = colorConstant(...hexToRgba(hex))
        break
      }
      case 'stroke': {
        const hex = resolveColor(prop.value) ?? (prop.value.startsWith('#') ? prop.value : null)
        if (hex) strokeColor = colorConstant(...hexToRgba(hex))
        break
      }
      case 'stroke-width': {
        const num = parseFloat(prop.value)
        if (!isNaN(num)) strokeWidth = num
        break
      }
      case 'stroke-linecap': {
        const v = prop.value
        if (v === 'butt' || v === 'round' || v === 'square' || v === 'arrow') linecap = v
        break
      }
      case 'stroke-linejoin': {
        const v = prop.value
        if (v === 'miter' || v === 'round' || v === 'bevel') linejoin = v
        break
      }
      case 'stroke-miterlimit': {
        const num = parseFloat(prop.value)
        if (!isNaN(num)) miterlimit = num
        break
      }
      case 'stroke-dasharray': {
        // "10 5" or "6 2 1 2" — whitespace or comma separated
        const nums = prop.value.split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n))
        if (nums.length >= 2) dashArray = nums
        break
      }
      case 'stroke-dashoffset': {
        const num = parseFloat(prop.value)
        if (!isNaN(num)) dashOffset = num
        break
      }
      case 'stroke-offset': {
        const num = parseFloat(prop.value)
        if (!isNaN(num)) strokeOffset = num
        break
      }
      case 'stroke-align':
      case 'stroke-alignment': {
        const v = prop.value.trim()
        if (v === 'center' || v === 'inset' || v === 'outset') strokeAlign = v
        break
      }
      case 'stroke-pattern': {
        pattern.shape = prop.value.trim()
        patternDirtyCss = true
        break
      }
      case 'stroke-pattern-spacing': {
        const pv = parseCssUnitValue(prop.value)
        if (pv) { pattern.spacing = pv.num; pattern.spacingUnit = pv.unit; patternDirtyCss = true }
        break
      }
      case 'stroke-pattern-size': {
        const pv = parseCssUnitValue(prop.value)
        if (pv) { pattern.size = pv.num; pattern.sizeUnit = pv.unit; patternDirtyCss = true }
        break
      }
      case 'stroke-pattern-offset': {
        const pv = parseCssUnitValue(prop.value)
        if (pv) { pattern.offset = pv.num; pattern.offsetUnit = pv.unit; patternDirtyCss = true }
        break
      }
      case 'stroke-pattern-anchor': {
        const v = prop.value.trim()
        if (v === 'repeat' || v === 'start' || v === 'end' || v === 'center') {
          pattern.anchor = v; patternDirtyCss = true
        }
        break
      }
      case 'opacity': {
        const num = parseFloat(prop.value)
        if (!isNaN(num)) opacity = opacityConstant(num <= 1 ? num : num / 100)
        break
      }
      case 'size': {
        break
      }
      case 'projection': {
        projection = prop.value
        break
      }
      case 'visible': {
        visible = prop.value === 'true'
        break
      }
    }
  }
  return {
    fill, strokeColor, strokeWidth, opacity, projection, visible,
    linecap, linejoin, miterlimit, dashArray, dashOffset, strokeOffset, strokeAlign,
    pattern: patternDirtyCss && pattern.shape && pattern.size > 0 && (pattern.spacing > 0 || pattern.anchor) ? pattern : undefined,
  }
}

/**
 * Expand apply-presetName items by inlining the preset's utility lines.
 * Preset items come first (lower priority), layer items come after (override).
 */
function expandPresets(
  utilities: AST.UtilityLine[],
  presetMap: Map<string, AST.UtilityLine[]>,
): AST.UtilityLine[] {
  const result: AST.UtilityLine[] = []

  for (const line of utilities) {
    const expandedItems: AST.UtilityItem[] = []

    for (const item of line.items) {
      if (item.name.startsWith('apply-') && !item.modifier) {
        const presetName = item.name.slice(6)
        const preset = presetMap.get(presetName)
        if (preset) {
          // Inline preset lines before current line's remaining items
          result.push(...preset)
        }
      } else {
        expandedItems.push(item)
      }
    }

    if (expandedItems.length > 0) {
      result.push({ kind: 'UtilityLine', items: expandedItems, line: line.line })
    }
  }

  return result
}

// ═══ Legacy syntax lowering ═══

function lowerLetAsSource(stmt: AST.LetStatement): SourceDef | null {
  if (stmt.value.kind !== 'FnCall') return null
  const callee = stmt.value.callee
  if (callee.kind !== 'Identifier' || callee.name !== 'load') return null
  const arg = stmt.value.args[0]
  if (!arg || arg.kind !== 'StringLiteral') return null

  // Detect type from URL pattern
  const url = arg.value
  const type = url.includes('{z}') ? 'raster' : 'geojson'

  return { name: stmt.name, type, url }
}

function lowerShow(stmt: AST.ShowStatement): RenderNode | null {
  let targetName = ''
  if (stmt.target.kind === 'Identifier') {
    targetName = stmt.target.name
  }
  if (!targetName) return null

  let fill: ColorValue = colorNone()
  let strokeColor: ColorValue = colorNone()
  let strokeWidth = 1
  let opacity = 1.0
  let projection = 'mercator'
  let visible = true

  for (const prop of stmt.block.properties) {
    if (prop.name === 'fill') {
      const val = prop.values[0]
      if (val?.kind === 'ColorLiteral') {
        fill = colorConstant(...hexToRgba(val.value))
      }
    } else if (prop.name === 'stroke') {
      const val = prop.values[0]
      if (val?.kind === 'ColorLiteral') {
        strokeColor = colorConstant(...hexToRgba(val.value))
      }
      const widthVal = prop.values[1]
      if (widthVal?.kind === 'NumberLiteral') {
        strokeWidth = widthVal.value
      }
    } else if (prop.name === 'opacity') {
      const val = prop.values[0]
      if (val?.kind === 'NumberLiteral') opacity = val.value
    } else if (prop.name === 'projection') {
      const val = prop.values[0]
      if (val?.kind === 'Identifier') projection = val.name
    } else if (prop.name === 'visible') {
      const val = prop.values[0]
      if (val?.kind === 'BoolLiteral') visible = val.value
    }
  }

  return {
    name: targetName,
    sourceRef: targetName,
    zOrder: 0,
    fill,
    stroke: { color: strokeColor, width: { kind: 'constant', value: strokeWidth } },
    opacity: opacityConstant(opacity),
    size: sizeNone(),
    projection,
    visible,
    pointerEvents: 'auto',
    filter: null,
    geometry: null,
    billboard: true,
    shape: shapeNone(),
    extrude: { kind: 'none' },
    extrudeBase: { kind: 'none' },
  }
}
