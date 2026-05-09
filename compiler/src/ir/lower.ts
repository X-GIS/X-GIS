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
  type ShapeRef,
} from './render-node'

/**
 * Lower an AST Program into an IR Scene.
 */
export function lower(program: AST.Program): Scene {
  const sources: SourceDef[] = []
  const renderNodes: RenderNode[] = []
  const symbols: import('./render-node').SymbolDef[] = []
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
        const node = lowerLayer(stmt, sourceMap, presetMap, styleMap, keyframesMap)
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

  return { sources, renderNodes, symbols }
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

function extractInterpolateZoomStops(
  expr: AST.Expr,
): Array<{ zoom: number; value: number }> | null {
  if (expr.kind !== 'FnCall') return null
  if (expr.callee.kind !== 'Identifier' || expr.callee.name !== 'interpolate') return null
  const args = expr.args
  // First arg must be the bare `zoom` identifier.
  if (args.length < 3) return null
  const input = args[0]
  if (input.kind !== 'Identifier' || input.name !== 'zoom') return null
  // Remaining args must alternate (numeric zoom, numeric value).
  if ((args.length - 1) % 2 !== 0) return null
  const stops: Array<{ zoom: number; value: number }> = []
  for (let i = 1; i + 1 < args.length; i += 2) {
    const zArg = args[i]
    const vArg = args[i + 1]
    if (zArg.kind !== 'NumberLiteral' || vArg.kind !== 'NumberLiteral') return null
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
): RenderNode | null {
  // Extract block properties
  let sourceRef = ''
  let sourceLayer: string | undefined
  let zOrder = 0
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
  let labelColor: [number, number, number, number] | undefined
  let labelHaloWidth: number | undefined
  let labelHaloColor: [number, number, number, number] | undefined
  let labelAnchor: import('./render-node').LabelDef['anchor'] | undefined
  let labelTransform: import('./render-node').LabelDef['transform'] | undefined
  let labelOffsetX: number | undefined
  let labelOffsetY: number | undefined
  let labelAllowOverlap: boolean | undefined
  let labelIgnorePlacement: boolean | undefined
  let labelPadding: number | undefined
  let labelRotate: number | undefined
  let labelLetterSpacing: number | undefined
  let labelFontStack: string[] | undefined
  let labelMaxWidth: number | undefined
  let labelLineHeight: number | undefined
  let labelJustify: 'auto' | 'left' | 'center' | 'right' | undefined

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
    } else if (prop.name === 'style' && prop.value.kind === 'Identifier') {
      styleRef = prop.value.name
    } else if (prop.name === 'filter') {
      filterExpr = prop.value
    } else if (prop.name === 'geometry') {
      geometryExpr = prop.value
    }
  }

  if (!sourceRef || !sourceMap.has(sourceRef)) return null

  // Expand presets: apply-name → inline preset's utility items
  const expandedUtilities = expandPresets(stmt.utilities, presetMap)

  // Process utility lines
  let fill: ColorValue = colorNone()
  let strokeColor: ColorValue = colorNone()
  let strokeWidth = 1
  let linecap: 'butt' | 'round' | 'square' | 'arrow' | undefined
  let linejoin: 'miter' | 'round' | 'bevel' | undefined
  let miterlimit: number | undefined
  let dashArray: number[] | undefined
  let dashOffset: number | undefined
  let strokeOffset: number | undefined
  let strokeAlign: 'center' | 'inset' | 'outset' | undefined
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
          for (const s of zoomStops) {
            opacityZoomStops.push({
              zoom: s.zoom,
              value: s.value <= 1 ? s.value : s.value / 100,
            })
          }
          continue
        }
        if (zoomStops && name === 'size') {
          for (const s of zoomStops) sizeZoomStops.push({ zoom: s.zoom, value: s.value })
          continue
        }
        if (zoomStops && name === 'label-size') {
          for (const s of zoomStops) labelSizeZoomStops.push({ zoom: s.zoom, value: s.value })
          continue
        }
        if (name === 'fill') {
          fill = { kind: 'data-driven', expr: { ast: item.binding } }
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
          // The runtime expands each feature's text into per-glyph
          // quads (Batch 1c). Engine plumbing not yet wired through
          // the renderers — for now this just preserves the IR so
          // Mapbox styles with `text-field` survive compilation.
          label = { text: bindingToTextValue(item.binding), size: 12 }
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
      if (name === 'label-justify-auto') { labelJustify = 'auto'; continue }
      if (name === 'label-justify-left') { labelJustify = 'left'; continue }
      if (name === 'label-justify-center') { labelJustify = 'center'; continue }
      if (name === 'label-justify-right') { labelJustify = 'right'; continue }
      if (name === 'label-anchor-center') { labelAnchor = 'center'; continue }
      if (name === 'label-anchor-top') { labelAnchor = 'top'; continue }
      if (name === 'label-anchor-bottom') { labelAnchor = 'bottom'; continue }
      if (name === 'label-anchor-left') { labelAnchor = 'left'; continue }
      if (name === 'label-anchor-right') { labelAnchor = 'right'; continue }
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
      if (name.startsWith('label-padding-')) {
        const num = parseFloat(name.slice('label-padding-'.length))
        if (!isNaN(num)) labelPadding = num
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
      if (name.startsWith('label-font-')) {
        // Each `label-font-X` utility APPENDS one font to the
        // fallback stack. Spaces in Mapbox font names round-trip
        // via `-`. Stack form (multiple utilities):
        //   | label-font-Noto-Sans-Regular label-font-Noto-Sans-CJK-Regular
        // The runtime feeds the whole stack to ctx.font as a
        // comma-separated CSS font value so the browser handles
        // glyph-by-glyph fallback automatically (Latin glyphs from
        // the first font, CJK from the second when the first lacks
        // them).
        const raw = name.slice('label-font-'.length)
        const restored = raw.replace(/-/g, ' ')
        if (restored.length > 0) {
          if (!labelFontStack) labelFontStack = []
          labelFontStack.push(restored)
        }
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
    opacity = { kind: 'zoom-interpolated', stops: opacityZoomStops }
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
    const baseRgba: [number, number, number, number] =
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
    const baseRgba: [number, number, number, number] =
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
    size = { kind: 'zoom-interpolated', stops: sizeZoomStops }
  }

  return {
    name: stmt.name,
    sourceRef,
    sourceLayer,
    zOrder,
    fill,
    stroke: (() => {
      const validPatterns = patternSlots.filter((p, i) =>
        patternDirty[i] && p.shape && p.size > 0 && (p.spacing > 0 || p.anchor !== 'repeat' && p.anchor !== undefined)
      )
      return {
        color: strokeColor,
        width: strokeWidth,
        linecap, linejoin, miterlimit,
        dashArray, dashOffset,
        patterns: validPatterns.length > 0 ? validPatterns : undefined,
        offset: strokeOffset,
        align: strokeAlign,
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
      labelSize, labelColor, labelHaloWidth, labelHaloColor,
      labelAnchor, labelTransform, labelOffsetX, labelOffsetY,
      labelSizeZoomStops: labelSizeZoomStops.length > 0 ? labelSizeZoomStops : undefined,
      labelAllowOverlap, labelIgnorePlacement, labelPadding,
      labelRotate, labelLetterSpacing, labelFontStack,
      labelMaxWidth, labelLineHeight, labelJustify,
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
    labelAnchor?: import('./render-node').LabelDef['anchor']
    labelTransform?: import('./render-node').LabelDef['transform']
    labelOffsetX?: number
    labelOffsetY?: number
    labelSizeZoomStops?: ZoomStop<number>[]
    labelAllowOverlap?: boolean
    labelIgnorePlacement?: boolean
    labelPadding?: number
    labelRotate?: number
    labelLetterSpacing?: number
    labelFontStack?: string[]
    labelMaxWidth?: number
    labelLineHeight?: number
    labelJustify?: 'auto' | 'left' | 'center' | 'right'
  },
): import('./render-node').LabelDef | undefined {
  if (!base) return undefined
  let halo = base.halo
  if (knobs.labelHaloWidth !== undefined || knobs.labelHaloColor !== undefined) {
    halo = {
      color: knobs.labelHaloColor ?? base.halo?.color ?? [0, 0, 0, 1],
      width: knobs.labelHaloWidth ?? base.halo?.width ?? 1,
      ...(base.halo?.blur !== undefined ? { blur: base.halo.blur } : {}),
    }
  }
  let offset = base.offset
  if (knobs.labelOffsetX !== undefined || knobs.labelOffsetY !== undefined) {
    offset = [
      knobs.labelOffsetX ?? base.offset?.[0] ?? 0,
      knobs.labelOffsetY ?? base.offset?.[1] ?? 0,
    ]
  }
  return {
    ...base,
    ...(knobs.labelSize !== undefined ? { size: knobs.labelSize } : {}),
    ...(knobs.labelColor !== undefined ? { color: knobs.labelColor } : {}),
    ...(halo !== undefined ? { halo } : {}),
    ...(knobs.labelAnchor !== undefined ? { anchor: knobs.labelAnchor } : {}),
    ...(knobs.labelTransform !== undefined ? { transform: knobs.labelTransform } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(knobs.labelSizeZoomStops && knobs.labelSizeZoomStops.length > 0
      ? { sizeZoomStops: knobs.labelSizeZoomStops } : {}),
    ...(knobs.labelAllowOverlap !== undefined ? { allowOverlap: knobs.labelAllowOverlap } : {}),
    ...(knobs.labelIgnorePlacement !== undefined ? { ignorePlacement: knobs.labelIgnorePlacement } : {}),
    ...(knobs.labelPadding !== undefined ? { padding: knobs.labelPadding } : {}),
    ...(knobs.labelRotate !== undefined ? { rotate: knobs.labelRotate } : {}),
    ...(knobs.labelLetterSpacing !== undefined ? { letterSpacing: knobs.labelLetterSpacing } : {}),
    ...(knobs.labelFontStack !== undefined && knobs.labelFontStack.length > 0
      ? { font: knobs.labelFontStack } : {}),
    ...(knobs.labelMaxWidth !== undefined ? { maxWidth: knobs.labelMaxWidth } : {}),
    ...(knobs.labelLineHeight !== undefined ? { lineHeight: knobs.labelLineHeight } : {}),
    ...(knobs.labelJustify !== undefined ? { justify: knobs.labelJustify } : {}),
  }
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
    stroke: { color: strokeColor, width: strokeWidth },
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
