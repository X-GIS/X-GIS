// ═══ Shader Variant Generator ═══
// Generates per-layer WGSL shader variants based on IR analysis.
// Three specialization axes: projection × value constants × feature data.

import type { RenderNode, ColorValue, OpacityValue } from '../ir/render-node'
import { rgbaToHex, hexToRgba } from '../ir/render-node'
import { exprToWGSL, collectFields, type WGSLFnEnv } from './wgsl-expr'
import { generatePaletteWGSL } from './categorical-encoder'
import { resolveColor } from '../tokens/colors'
import type { Palette } from './palette'
import {
  emitColorGradientSample,
  emitScalarGradientSample,
  emitScalarSampleHelper,
  emitPaletteBindings,
  type ScalarPaletteMode,
} from './palette-emit'

/**
 * A specialized shader variant for a layer.
 */
export interface ShaderVariant {
  /** Cache key — layers with identical keys share a pipeline */
  key: string
  /** WGSL const declarations to prepend to the shader */
  preamble: string
  /** WGSL expression for fill color (replaces `u.fill_color`) */
  fillExpr: string
  /** WGSL expression for stroke color (replaces `u.stroke_color`) */
  strokeExpr: string
  /** WGSL code injected before fill return (match if-else chains) */
  fillPreamble?: string
  /** WGSL code injected before stroke return — analogous to
   *  `fillPreamble` for the stroke entry point. Without this, a
   *  `match()` expression on stroke colour produces an `_mcSS = ...`
   *  if-else chain whose VAR DECLARATION is dropped on the floor
   *  while the `expr` still references the var name → "unresolved
   *  identifier _mc83" at WGSL compile time. */
  strokePreamble?: string
  /** Whether a storage buffer is needed for per-feature data */
  needsFeatureBuffer: boolean
  /** Fields needed from feature data (for storage buffer layout) */
  featureFields: string[]
  /** Which uniform fields are still needed (not inlined) */
  uniformFields: string[]
  /** For every field consumed by a `match()` expression, the
   *  AUTHORITATIVE sorted list of string patterns the shader's
   *  if-else chain expects. The runtime must use this list as the
   *  string → integer-ID map when packing the per-feature data
   *  buffer; otherwise the IDs computed from "unique values in this
   *  tile's data" can collide with the shader's compile-time IDs.
   *  Example: shader knows {cemetery,hospital,railway,school}={0,1,
   *  2,3} but a tile with only "school" features would otherwise
   *  encode school=0 — colliding with cemetery's slot in the
   *  shader's if-else chain. */
  categoryOrder: Record<string, string[]>
  /** P3 Step 3 — non-empty when this variant sampled a gradient from
   *  the palette atlas. The runtime uses this signal to:
   *    (a) bind the palette textures + sampler to the variant's
   *        pipeline (Step 3c).
   *    (b) skip the zoom-interpolated CPU resolve path for these
   *        properties (Step 4) — the shader reads the per-zoom
   *        value via textureSampleLevel each frame instead.
   *  Empty when `palette` is omitted from generateShaderVariant or
   *  the node has no zoom-interpolated paint properties. */
  paletteColorGradients: number[]
  /** P3 Step 3c-scalar — non-empty when the variant samples a scalar
   *  gradient (opacity / stroke-width zoom-interpolated). Runtime uses
   *  it to bind the scalar atlas + sampler and skip the per-frame
   *  `resolveNumberShape(...)` CPU eval for the routed axes. */
  paletteScalarGradients: number[]
  /** P3 Step 4 — true when fill's zoom-interpolated colour routed
   *  through `textureSampleLevel`. The bucket-scheduler skips the
   *  per-frame `resolveColorShape(paintShapes.fill, …)` CPU eval
   *  for these axes — the fragment shader reads from the gradient
   *  atlas directly, so the CPU result would be a dead write into
   *  `u.fill_color`. */
  fillUsesPalette: boolean
  /** Stroke counterpart to `fillUsesPalette`. */
  strokeUsesPalette: boolean
  /** True when opacity's zoom-interpolated value routed through the
   *  scalar atlas. The bucket-scheduler skips the per-frame
   *  `resolveNumberShape(paintShapes.opacity, …)` CPU eval and the
   *  paired `u.opacity` writeBuffer when this is set. */
  opacityUsesPalette: boolean
  /** P4-5 — populated by `mergeComputeAddendumIntoVariant` when the
   *  fill / stroke axis routed through a compute kernel. Each entry
   *  is `(paintAxis, bindGroup, binding)` so the runtime can detect
   *  "this variant needs the compute bind-group layout" via existence
   *  + iterate to attach the right `TileComputeResources.getOutBuffer`
   *  per binding without re-parsing the preamble. Absent on legacy
   *  variants and on variants whose computePlan filter returned
   *  empty for this show. */
  computeBindings?: readonly import('./compute-output-binding').ComputeOutputBindingSpec[]
}

/**
 * Generate a shader variant for a RenderNode.
 * Determines what can be inlined as constants vs what needs uniforms/storage.
 *
 * When `palette` is supplied (Step 3b onward), zoom-interpolated
 * paint values emit a `textureSampleLevel` of the pre-baked gradient
 * atlas instead of falling through to `u.fill_color`. Omitting
 * `palette` (default) preserves the legacy uniform path byte-
 * identical — every existing caller is unchanged.
 */
export function generateShaderVariant(
  node: RenderNode,
  fnEnv?: WGSLFnEnv,
  palette?: Palette,
  scalarPaletteMode: ScalarPaletteMode = 'manual',
): ShaderVariant {
  const preambleLines: string[] = []
  const uniformFields: string[] = ['mvp', 'proj_params']
  const allFeatureFields = new Set<string>()
  let needsFeatureBuffer = false

  // Collected palette gradient indices. Non-empty when ANY paint
  // property routed through the textureSampleLevel path (Step 3b).
  // Runtime (Step 3c) reads `paletteColorGradients` from the
  // ShaderVariant to decide whether to bind the atlas textures +
  // skip the zoom-interpolated CPU resolve.
  const paletteColorGradients: number[] = []
  const paletteScalarGradients: number[] = []

  // ── Fill ──
  const fillResult = processColorValue(node.fill, 'FILL', allFeatureFields, fnEnv, palette)
  preambleLines.push(...fillResult.preamble)
  if (!fillResult.isConst) uniformFields.push('fill_color')
  if (fillResult.needsFeatures) needsFeatureBuffer = true
  if (fillResult.paletteGradientIdx !== undefined) {
    paletteColorGradients.push(fillResult.paletteGradientIdx)
  }

  // ── Stroke ──
  const strokeResult = processColorValue(node.stroke.color, 'STROKE', allFeatureFields, fnEnv, palette)
  preambleLines.push(...strokeResult.preamble)
  if (!strokeResult.isConst) uniformFields.push('stroke_color')
  if (strokeResult.needsFeatures) needsFeatureBuffer = true
  if (strokeResult.paletteGradientIdx !== undefined) {
    paletteColorGradients.push(strokeResult.paletteGradientIdx)
  }

  // ── Opacity ──
  const opacityResult = processOpacity(node.opacity, allFeatureFields, fnEnv, palette)
  preambleLines.push(...opacityResult.preamble)
  if (opacityResult.needsUniform) uniformFields.push('opacity')
  if (opacityResult.needsFeatures) needsFeatureBuffer = true
  if (opacityResult.paletteScalarIdx !== undefined) {
    paletteScalarGradients.push(opacityResult.paletteScalarIdx)
  }

  // ── Build final expressions ──
  // When the layer has no fill at all (`kind: 'none'`), emit the default
  // `u.fill_color` placeholder rather than `vec4f(FILL_COLOR.rgb, ...)`
  // with the all-zero const. The runtime treats `fillExpr === 'u.fill_color'`
  // as "use the cached uniform color" and combines that with the
  // `cachedFillColor[3] <= 0.005` check to skip the entire fill draw —
  // which is the right behavior for stroke-only layers (no fill draw
  // means no pick attachment write either, so picks fall through to
  // whatever drew underneath).
  const fillExpr = node.fill.kind === 'none'
    ? 'u.fill_color'
    : buildFillExpr(fillResult, opacityResult)
  const strokeExpr = buildStrokeExpr(strokeResult, opacityResult)

  // ── Cache key ──
  const featureFields = [...allFeatureFields].sort()
  const key = buildKey(node, fillResult, strokeResult, opacityResult, featureFields)
    // Match-arms hash: two compound layers (same field, different
    // value→colour mappings) produce IDENTICAL `f:feat|ff:kind`
    // keys but DIFFERENT shader bodies — the if-else chain in
    // matchPreamble differs. Without this, the variant cache
    // returns the FIRST compiled compound's pipeline for the
    // SECOND compound's draws → roads end up rendered with
    // landuse colours (or vice versa). Including a hash of the
    // injected match preambles disambiguates them.
    + matchArmsKey(fillResult.matchPreamble, strokeResult.matchPreamble)

  // Aggregate categoryOrder from fill + stroke results. Both code
  // paths sort patterns alphabetically, so a field used by BOTH fill
  // and stroke matches gets the same order (later spread overrides
  // identical values harmlessly). Opacity doesn't use match() today.
  const categoryOrder: Record<string, string[]> = {
    ...(fillResult.categoryOrder ?? {}),
    ...(strokeResult.categoryOrder ?? {}),
  }

  // Prepend palette binding declarations + helper functions when the
  // variant actually samples either atlas. Skipped when both gradient
  // lists are empty so existing (non-palette) variants stay
  // byte-identical with the legacy path.
  if (palette && (paletteColorGradients.length > 0 || paletteScalarGradients.length > 0)) {
    const bindings = emitPaletteBindings(palette)
    const scalarHelper = paletteScalarGradients.length > 0
      ? emitScalarSampleHelper(palette, scalarPaletteMode)
      : ''
    const prefix = bindings + scalarHelper
    if (prefix) preambleLines.unshift(prefix)
  }

  return {
    key,
    preamble: preambleLines.join('\n'),
    fillExpr,
    strokeExpr,
    fillPreamble: fillResult.matchPreamble,
    strokePreamble: strokeResult.matchPreamble,
    needsFeatureBuffer,
    featureFields,
    uniformFields,
    categoryOrder,
    paletteColorGradients,
    paletteScalarGradients,
    fillUsesPalette: fillResult.paletteGradientIdx !== undefined,
    strokeUsesPalette: strokeResult.paletteGradientIdx !== undefined,
    opacityUsesPalette: opacityResult.paletteScalarIdx !== undefined,
  }
}

// ═══ Value processing ═══

interface ColorResult {
  preamble: string[]
  isConst: boolean
  /** Index into `palette.colorGradients` when this result was routed
   *  through the textureSampleLevel path. Undefined for every legacy
   *  path (constant, time-interpolated, data-driven, conditional). */
  paletteGradientIdx?: number
  needsFeatures: boolean
  isVec4: boolean  // true if expr already returns vec4f (categorical/gradient)
  expr: string // WGSL expression for the color
  matchPreamble?: string // if-else chain for match() — injected before return in fragment
  /** field → ordered list of patterns the if-else chain expects. The
   *  runtime uses this to assign matching integer IDs into the per-
   *  feature data buffer. Without this, IDs would be derived from
   *  the data's unique values (alphabetical), which collide with the
   *  shader's compile-time pattern order whenever the data is a
   *  proper subset of the patterns. */
  categoryOrder?: Record<string, string[]>
}

function processColorValue(
  value: ColorValue,
  prefix: string,
  featureFields: Set<string>,
  fnEnv?: WGSLFnEnv,
  palette?: Palette,
): ColorResult {
  if (value.kind === 'none') {
    return {
      preamble: [`const ${prefix}_COLOR: vec4f = vec4f(0.0, 0.0, 0.0, 0.0);`],
      isConst: true, needsFeatures: false, isVec4: true,
      expr: `${prefix}_COLOR`,
    }
  }

  if (value.kind === 'constant') {
    const [r, g, b, a] = value.rgba
    return {
      preamble: [`const ${prefix}_COLOR: vec4f = vec4f(${fmt(r)}, ${fmt(g)}, ${fmt(b)}, ${fmt(a)});`],
      isConst: true, needsFeatures: false, isVec4: true,
      expr: `${prefix}_COLOR`,
    }
  }

  if (value.kind === 'time-interpolated') {
    // CPU resolves the animated color each frame and writes it into the
    // fill_color / stroke_color uniform slot. Shader just reads from the
    // uniform. Mirrors the opacity path that already routes zoom- /
    // time-interpolated opacity through `u.opacity`.
    const uniformName = prefix === 'FILL' ? 'u.fill_color' : 'u.stroke_color'
    return {
      preamble: [],
      isConst: false, needsFeatures: false, isVec4: true,
      expr: uniformName,
    }
  }

  if (value.kind === 'data-driven') {
    const fields = collectFields(value.expr.ast)
    fields.forEach(f => featureFields.add(f))
    const fieldMap = buildFieldMap(featureFields)
    const ast = value.expr.ast

    // ── categorical(field) → auto palette ──
    if (ast.kind === 'FnCall' && ast.callee.kind === 'Identifier' && ast.callee.name === 'categorical') {
      const fieldExpr = ast.args[0]
      const wgsl = exprToWGSL(fieldExpr, fieldMap, fnEnv)
      return {
        preamble: [generatePaletteWGSL()],
        isConst: false, needsFeatures: true, isVec4: true,
        expr: `CAT_PALETTE[u32(${wgsl}) % 20u]`,
      }
    }

    // ── match(field) { "val" -> color, ... } → if-else chain ──
    if (ast.kind === 'FnCall' && ast.callee.kind === 'Identifier' && ast.callee.name === 'match' && ast.matchBlock) {
      const fieldExpr = ast.args[0]
      const wgsl = exprToWGSL(fieldExpr, fieldMap, fnEnv)
      const arms = ast.matchBlock.arms
      let fallbackColor = 'vec4f(0.5, 0.5, 0.5, 1.0)'
      const branches: string[] = []
      let varName = `_mc${prefix.charCodeAt(0)}`

      for (const arm of arms) {
        const rgba = resolveColorFromAST(arm.value)
        if (!rgba) continue
        const [r, g, b, a] = rgba
        const colorVec = `vec4f(${fmt(r)}, ${fmt(g)}, ${fmt(b)}, ${fmt(a)})`
        if (arm.pattern === '_') {
          fallbackColor = colorVec
        } else {
          // Category ID is assigned alphabetically at data-load time
          // At shader-gen we emit by pattern order; runtime maps strings → IDs
          branches.push({ pattern: arm.pattern, color: colorVec } as any)
        }
      }

      // Sort patterns alphabetically to match runtime category ID assignment
      const sortedPatterns = arms
        .filter(a => a.pattern !== '_')
        .map(a => a.pattern)
        .sort()
      const patternToId = new Map(sortedPatterns.map((p, i) => [p, i]))

      let ifElse = `var ${varName}: vec4f = ${fallbackColor};\n`
      for (const arm of arms) {
        if (arm.pattern === '_') continue
        const id = patternToId.get(arm.pattern)
        if (id === undefined) continue
        const rgba = resolveColorFromAST(arm.value)
        if (!rgba) continue
        const [r, g, b, a] = rgba
        ifElse += `  if (${wgsl} == ${fmt(id)}) { ${varName} = vec4f(${fmt(r)}, ${fmt(g)}, ${fmt(b)}, ${fmt(a)}); }\n`
      }

      // Surface the (sortedPatterns) list for THIS field so the runtime
      // can encode feature data with matching IDs. Only the simple
      // `match(.field) { … }` shape with a FieldAccess argument exposes
      // a single field — chained / function-call arguments fall through
      // to the legacy "unique-data sort" path (which is correct when
      // the patterns cover every possible feature value).
      const categoryOrder: Record<string, string[]> = {}
      if (fieldExpr.kind === 'FieldAccess' && fieldExpr.object === null) {
        categoryOrder[fieldExpr.field] = sortedPatterns
      }

      return {
        preamble: [],
        isConst: false, needsFeatures: true, isVec4: true,
        expr: `/* match */ ${varName}`,
        matchPreamble: ifElse,
        categoryOrder,
      } as ColorResult
    }

    // ── gradient(field, min, max, colorLow, colorHigh) → mix() ──
    if (ast.kind === 'FnCall' && ast.callee.kind === 'Identifier' && ast.callee.name === 'gradient' && ast.args.length === 5) {
      const valExpr = exprToWGSL(ast.args[0], fieldMap, fnEnv)
      const minExpr = exprToWGSL(ast.args[1], fieldMap, fnEnv)
      const maxExpr = exprToWGSL(ast.args[2], fieldMap, fnEnv)
      const lowColor = resolveColorFromAST(ast.args[3])
      const highColor = resolveColorFromAST(ast.args[4])
      if (lowColor && highColor) {
        const [lr, lg, lb, la] = lowColor
        const [hr, hg, hb, ha] = highColor
        return {
          preamble: [],
          isConst: false, needsFeatures: true, isVec4: true,
          expr: `mix(vec4f(${fmt(lr)}, ${fmt(lg)}, ${fmt(lb)}, ${fmt(la)}), vec4f(${fmt(hr)}, ${fmt(hg)}, ${fmt(hb)}, ${fmt(ha)}), clamp((${valExpr} - ${minExpr}) / (${maxExpr} - ${minExpr}), 0.0, 1.0))`,
        }
      }
    }

    // ── Legacy: fill-[name] / fill-[.name] → auto palette (backward compat) ──
    if (ast.kind === 'FieldAccess' || (ast.kind === 'Identifier' && ast.name !== 'zoom')) {
      const wgsl = exprToWGSL(ast, fieldMap, fnEnv)
      return {
        preamble: [generatePaletteWGSL()],
        isConst: false, needsFeatures: true, isVec4: true,
        expr: `CAT_PALETTE[u32(${wgsl}) % 20u]`,
      }
    }

    // ── Legacy: scale(field, min, max, colorLow, colorHigh) ──
    if (ast.kind === 'FnCall' && ast.callee.kind === 'Identifier' && ast.callee.name === 'scale' && ast.args.length === 5) {
      const valExpr = exprToWGSL(ast.args[0], fieldMap, fnEnv)
      const minExpr = exprToWGSL(ast.args[1], fieldMap, fnEnv)
      const maxExpr = exprToWGSL(ast.args[2], fieldMap, fnEnv)
      const lowColor = resolveColorFromAST(ast.args[3])
      const highColor = resolveColorFromAST(ast.args[4])
      if (lowColor && highColor) {
        const [lr, lg, lb, la] = lowColor
        const [hr, hg, hb, ha] = highColor
        return {
          preamble: [],
          isConst: false, needsFeatures: true, isVec4: true,
          expr: `mix(vec4f(${fmt(lr)}, ${fmt(lg)}, ${fmt(lb)}, ${fmt(la)}), vec4f(${fmt(hr)}, ${fmt(hg)}, ${fmt(hb)}, ${fmt(ha)}), clamp((${valExpr} - ${minExpr}) / (${maxExpr} - ${minExpr}), 0.0, 1.0))`,
        }
      }
    }

    // Default: scalar data-driven expression
    const wgsl = exprToWGSL(ast, fieldMap, fnEnv)
    return {
      preamble: [],
      isConst: false, needsFeatures: true, isVec4: false,
      expr: wgsl,
    }
  }

  // Zoom-interpolated path: when a palette is provided AND the
  // gradient is already collected (P3 Step 1), emit the
  // textureSampleLevel call so the GPU samples the pre-baked atlas
  // (P3 Step 2) once per fragment. Falls back to the legacy
  // `u.fill_color` uniform when no palette is wired — preserves
  // every existing caller's WGSL output byte-identical.
  if (value.kind === 'zoom-interpolated' && palette) {
    const gradientIdx = palette.findColorGradient({
      stops: value.stops,
      base: value.base ?? 1,
    })
    if (gradientIdx >= 0) {
      return {
        preamble: [],
        isConst: false, needsFeatures: false, isVec4: true,
        expr: emitColorGradientSample(palette, gradientIdx),
        paletteGradientIdx: gradientIdx,
      }
    }
  }

  // conditional, zoom-interpolated (no palette), …  → fall back to uniform
  return {
    preamble: [],
    isConst: false, needsFeatures: false, isVec4: true,
    expr: `u.${prefix.toLowerCase()}_color`,
  }
}

interface OpacityResult {
  preamble: string[]
  needsUniform: boolean
  needsFeatures: boolean
  expr: string
  /** Set when this opacity is `zoom-interpolated` AND a matching
   *  scalar gradient was collected into the palette pool. Variant
   *  caller pushes onto `paletteScalarGradients` so the runtime can
   *  skip the per-frame `u.opacity` CPU write. */
  paletteScalarIdx?: number
}

function processOpacity(
  value: OpacityValue,
  featureFields: Set<string>,
  fnEnv?: WGSLFnEnv,
  palette?: Palette,
): OpacityResult {
  if (value.kind === 'constant') {
    return {
      preamble: [`const OPACITY: f32 = ${fmt(value.value)};`],
      needsUniform: false,
      needsFeatures: false,
      expr: 'OPACITY',
    }
  }

  if (value.kind === 'data-driven') {
    const fields = collectFields(value.expr.ast)
    fields.forEach(f => featureFields.add(f))
    const fieldMap = buildFieldMap(featureFields)
    const wgsl = exprToWGSL(value.expr.ast, fieldMap, fnEnv)
    return {
      preamble: [],
      needsUniform: false,
      needsFeatures: true,
      expr: wgsl,
    }
  }

  // zoom-interpolated: route through the scalar atlas when the palette
  // is supplied AND it carries scalar gradients (collectPalette dedups
  // by stops shape — multiple shows with identical stops share one
  // row). Caller decides between filtering / manual mode via
  // generateShaderVariant's scalarPaletteMode argument.
  //
  // Empty scalarGradients == the runtime hasn't opted INTO scalar
  // sampling yet — emit-commands sets this by only passing a
  // scalar-gradient-bearing palette when the caller flipped
  // `enableScalarPaletteSampling`. Keeps the bind-group layout
  // contract bidirectional with the runtime side.
  if (value.kind === 'zoom-interpolated' && palette && palette.scalarGradients.length > 0) {
    // The shape of OpacityValue's zoom-interpolated stops matches
    // PropertyShape<number>, so findScalarGradient lookup works
    // identically across the codepaths that feed collectPalette.
    const idx = palette.findScalarGradient({
      stops: value.stops,
      base: value.base ?? 1,
    })
    if (idx >= 0) {
      return {
        preamble: [],
        needsUniform: false,
        needsFeatures: false,
        // emitScalarGradientSample emits `xgis_scalar_sample(...)` —
        // the helper definition is appended once per variant by
        // generateShaderVariant.
        expr: emitScalarGradientSample(palette, idx),
        paletteScalarIdx: idx,
      }
    }
  }

  // Fallback: zoom-interpolated without a palette entry, or any other
  // unhandled kind → uniform write per frame (legacy path).
  return {
    preamble: [],
    needsUniform: true,
    needsFeatures: false,
    expr: 'u.opacity',
  }
}

// ═══ Expression builders ═══

function buildFillExpr(color: ColorResult, opacity: OpacityResult): string {
  if (color.isVec4) {
    // Expression already returns vec4f (constant, categorical, gradient)
    return `vec4f(${color.expr}.rgb, ${color.expr}.a * ${opacity.expr})`
  }
  if (color.needsFeatures) {
    // Data-driven scalar → grayscale
    return `vec4f(${color.expr}, ${color.expr}, ${color.expr}, ${opacity.expr})`
  }
  return `vec4f(${color.expr}.rgb, ${color.expr}.a * ${opacity.expr})`
}

function buildStrokeExpr(color: ColorResult, opacity: OpacityResult): string {
  if (color.isConst && opacity.expr === 'OPACITY') {
    return `vec4f(${color.expr}.rgb, ${color.expr}.a * ${opacity.expr})`
  }
  return `vec4f(${color.expr}.rgb, ${color.expr}.a * ${opacity.expr})`
}

// ═══ Helpers ═══

function buildFieldMap(fields: Set<string>): Map<string, number> {
  const map = new Map<string, number>()
  let offset = 0
  for (const field of [...fields].sort()) {
    map.set(field, offset++)
  }
  return map
}

/** Stable short hash of the fill / stroke match-preamble bodies.
 *  Returns empty string when both are absent so non-match variants
 *  keep their existing cache key bytes unchanged. */
function matchArmsKey(fillPre: string | undefined, strokePre: string | undefined): string {
  if (!fillPre && !strokePre) return ''
  const combined = `${fillPre ?? ''}${strokePre ?? ''}`
  let h = 5381
  for (let i = 0; i < combined.length; i++) {
    h = (h * 33) ^ combined.charCodeAt(i)
    h |= 0
  }
  return `|m:${(h >>> 0).toString(36)}`
}

function buildKey(
  node: RenderNode,
  fill: ColorResult,
  stroke: ColorResult,
  _opacity: OpacityResult,
  featureFields: string[],
): string {
  const parts: string[] = []

  // Fill key
  if (fill.isConst && node.fill.kind === 'constant') {
    parts.push(`f:${rgbaToHex(node.fill.rgba)}`)
  } else if (fill.isConst) {
    parts.push('f:none')
  } else if (fill.needsFeatures) {
    parts.push(`f:feat`)
  } else {
    parts.push('f:dyn')
  }

  // Stroke key
  if (stroke.isConst && node.stroke.color.kind === 'constant') {
    parts.push(`s:${rgbaToHex(node.stroke.color.rgba)}`)
  } else if (stroke.isConst) {
    parts.push('s:none')
  } else {
    parts.push('s:dyn')
  }

  // Opacity key
  if (node.opacity.kind === 'constant') {
    parts.push(`o:${node.opacity.value}`)
  } else {
    parts.push('o:dyn')
  }

  // Feature fields
  if (featureFields.length > 0) {
    parts.push(`ff:${featureFields.join(',')}`)
  }

  return parts.join('|')
}

/** Resolve a color from an AST node (Identifier like "green-100") */
function resolveColorFromAST(node: import('../parser/ast').Expr): [number, number, number, number] | null {
  if (node.kind === 'Identifier') {
    const hex = resolveColor(node.name)
    if (hex) return hexToRgba(hex)
  }
  if (node.kind === 'StringLiteral') {
    const hex = resolveColor(node.value)
    if (hex) return hexToRgba(hex)
  }
  // Hex literal direct from a synthesized AST (e.g. mergeLayers'
  // `match() { value -> #rrggbbaa }` arms) AND user-authored short
  // forms (`fill: #fff`). Without the 4/5 lengths the short form
  // would collapse to "no colour" — fragment match preambles end up
  // containing only the default variable declaration, variant cache
  // keys collide across compounds, and the wrong pipeline gets
  // shared. CSS allows 3/4/6/8 hex digits (lengths 4/5/7/9 with #).
  if (node.kind === 'ColorLiteral' && typeof node.value === 'string') {
    const hex = node.value
    if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) {
      return hexToRgba(hex)
    }
  }
  // Hyphenated color names parsed as subtraction: sky-300 → Identifier("sky") - NumberLiteral(300)
  if (node.kind === 'BinaryExpr' && node.op === '-'
      && node.left.kind === 'Identifier'
      && node.right.kind === 'NumberLiteral') {
    const colorName = `${node.left.name}-${node.right.value}`
    const hex = resolveColor(colorName)
    if (hex) return hexToRgba(hex)
  }
  // CSS rgb / rgba / hsl / hsla function call. Reconstruct the
  // source-text from the AST so the same parser in resolveColor()
  // (which already handles the string form) can produce hex.
  if (node.kind === 'FnCall' && node.callee.kind === 'Identifier') {
    const name = node.callee.name.toLowerCase()
    if (name === 'rgb' || name === 'rgba' || name === 'hsl' || name === 'hsla') {
      const reconstructed = reconstructCssFnCall(node)
      if (reconstructed) {
        const hex = resolveColor(reconstructed)
        if (hex) return hexToRgba(hex)
      }
    }
  }
  return null
}

/** Reconstruct a CSS-style function call string (e.g. "rgb(255, 0,
 *  0)" or "hsl(120deg, 50%, 50%)") from a parsed FnCall AST. Numeric
 *  literals and identifiers are emitted verbatim; anything else
 *  yields null so resolveColorFromAST falls through. */
function reconstructCssFnCall(call: { callee: import('../parser/ast').Expr; args: import('../parser/ast').Expr[] }): string | null {
  if (call.callee.kind !== 'Identifier') return null
  const parts: string[] = []
  for (const a of call.args) {
    const piece = exprToCssArg(a)
    if (piece === null) return null
    parts.push(piece)
  }
  return `${call.callee.name}(${parts.join(', ')})`
}

function exprToCssArg(node: import('../parser/ast').Expr): string | null {
  if (node.kind === 'NumberLiteral') return String(node.value)
  // `50%` parses as Identifier("%") preceded by a number? No — the
  // lexer doesn't produce a `%` token. CSS percent literals can't be
  // expressed in the parser today; users wanting hsl() must drop the
  // `%` (`hsl(120, 50, 50)` — the colour parser tolerates the
  // unitless form). Same story for `0.5` alpha which parses cleanly.
  if (node.kind === 'Identifier') return node.name
  // `120deg` / `0.5turn`: BinaryExpr would be wrong, but the lexer
  // recognises `deg` etc. as Px-equivalent unit tokens that stick to
  // the preceding number — so a user writing `hsl(120deg, ...)`
  // actually emits a single Identifier("120deg") via parseUtilityName
  // up the chain. Out of scope here.
  return null
}

function fmt(n: number): string {
  const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0')
  return s
}
