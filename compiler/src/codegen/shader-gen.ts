// ═══ Shader Variant Generator ═══
// Generates per-layer WGSL shader variants based on IR analysis.
// Three specialization axes: projection × value constants × feature data.

import type { RenderNode, ColorValue, OpacityValue } from '../ir/render-node'
import { rgbaToHex } from '../ir/render-node'
import { exprToWGSL, collectFields, type WGSLFnEnv } from './wgsl-expr'
import { generatePaletteWGSL } from './categorical-encoder'
import type { Palette } from './palette'
import {
  emitColorGradientSample,
  emitColorGradientSampleNode,
  emitScalarGradientSample,
  emitScalarGradientSampleNode,
  emitScalarSampleHelper,
  emitPaletteBindings,
  type ScalarPaletteMode,
} from './palette-emit'
import type { ShaderVariant, ColorResult, OpacityResult } from './shader-gen-types'
import { wgslRaw } from './node-types'
import type { NodeLike } from './node-types'
import {
  composeFillVec4, constRefVec4, refF32,
  toU32, u32Lit, u32Mod, arrayIndex, featDataField,
  mix4, clampF32, f32Add, f32Sub, f32Mul, f32Div, f32Lit, vec4fFromRgba,
} from './_util/node-builders'
import {
  buildFieldMap,
  matchArmsKey,
  resolveColorFromAST,
  fmt,
} from './shader-gen-helpers'

export type { ShaderVariant } from './shader-gen-types'

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
  // Phase 2.5 US-004 — fillExpr / strokeExpr are now Node-typed
  // (NodeLike<'vec4<f32>'> | null). The default-uniform shortcut
  // becomes a literal `null` paired with `fillIsDefault: true` below;
  // the runtime checks the flag, NOT the field's contents.
  //
  // US-005 idiom #1 (constant-fill + constant-opacity) — when the
  // fillResult is the FILL_COLOR const path AND opacityResult is the
  // OPACITY const path, build fillExpr via real DSL Node composition
  // (composeFillVec4(constRefVec4('FILL_COLOR'), refF32('OPACITY'))).
  // Every other arm stays on the legacy wgslRaw() string path until
  // US-005's per-idiom commits land them too. Both paths produce
  // semantic-equivalent WGSL at the marker substitution site;
  // pixel-survey is the integration gate.
  const fillExprStr = node.fill.kind === 'none' ? 'u.fill_color' : buildFillExpr(fillResult, opacityResult)
  const strokeExprStr = buildStrokeExpr(strokeResult, opacityResult)
  // US-005 dispatch order: prefer the per-idiom arm's `nodeExpr`
  // (lands one bucket at a time), then the generic varref-pair
  // pattern, finally fall back to wgslRaw(legacy string). Each
  // ColorResult / OpacityResult arm that migrates sets `.nodeExpr`
  // and the legacy string path quietly retreats.
  const fillExprNode = fillResult.nodeExpr && opacityResult.nodeExpr
    ? composeFillVec4(fillResult.nodeExpr, opacityResult.nodeExpr)
    : tryComposeFillNodeFromVarrefs(fillResult, opacityResult)
  const strokeExprNode = strokeResult.nodeExpr && opacityResult.nodeExpr
    ? composeFillVec4(strokeResult.nodeExpr, opacityResult.nodeExpr)
    : tryComposeFillNodeFromVarrefs(strokeResult, opacityResult)
  const fillExpr: NodeLike<'vec4<f32>'> | null =
    node.fill.kind === 'none' ? null
      : (fillExprNode ?? wgslRaw<'vec4<f32>'>(fillExprStr))
  const strokeExpr: NodeLike<'vec4<f32>'> | null =
    strokeExprStr === 'u.stroke_color' ? null
      : (strokeExprNode ?? wgslRaw<'vec4<f32>'>(strokeExprStr))

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
    // Phase 2.5 US-002+US-004 — typed default-sentinel flags. After
    // US-004's Node migration the field carries `null` for the
    // default-uniform placeholder, and the flag tracks that shape
    // directly. Meaning is stable across the migration: "use the
    // cached uniform colour + skip-fill-draw fast path".
    fillIsDefault: fillExpr === null,
    strokeIsDefault: strokeExpr === null,
  }
}

// ═══ Value processing ═══

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
      // Phase 2.5 US-005 idiom #3 (categorical) — when the field
      // argument is a direct FieldAccess / Identifier (the
      // overwhelmingly common shape; OFM landuse / road class etc.),
      // build a real Node via featDataField + toU32 + u32Mod +
      // arrayIndex(CAT_PALETTE). Falls back to wgslRaw for the
      // arithmetic / builtin-call AST sub-shapes — those need the
      // full DataExpr->Node converter (deferred to a later commit).
      const fieldName = (fieldExpr && (fieldExpr.kind === 'Identifier'
        ? fieldExpr.name
        : fieldExpr.kind === 'FieldAccess' ? fieldExpr.field : null)) ?? null
      const fieldNode = fieldName ? featDataField(fieldName, fieldMap) : null
      const nodeExpr = fieldNode
        ? arrayIndex<'vec4<f32>'>(
            constRefVec4('CAT_PALETTE') as NodeLike<string>,
            u32Mod(toU32(fieldNode), u32Lit(20)),
            'vec4<f32>',
          )
        : undefined
      return {
        preamble: [generatePaletteWGSL()],
        isConst: false, needsFeatures: true, isVec4: true,
        expr: `CAT_PALETTE[u32(${wgsl}) % 20u]`,
        nodeExpr,
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
        // Phase 2.5 US-005 idiom (match-chain surface) — fillExpr at
        // the marker site is just a varref to the chain's slot var.
        // The matchPreamble string (Stmt[] migration deferred to
        // US-007's polygon composer) is injected separately. Comment
        // prefix '/* match */' is dropped in the Node form — AC6
        // allows comment-placement differences.
        nodeExpr: constRefVec4(varName),
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
        // Phase 2.5 US-005 idiom (gradient) — when val/min/max are
        // simple field accesses or number literals, build mix4(low,
        // high, clamp(...)) Node end-to-end. Falls back to wgslRaw
        // when any of the three args needs the full DataExpr->Node
        // converter (compound binops, builtin calls).
        const valNode = simpleScalarNode(ast.args[0], fieldMap)
        const minNode = simpleScalarNode(ast.args[1], fieldMap)
        const maxNode = simpleScalarNode(ast.args[2], fieldMap)
        const nodeExpr = (valNode && minNode && maxNode)
          ? mix4(
              vec4fFromRgba(lowColor),
              vec4fFromRgba(highColor),
              clampF32(f32Div(f32Sub(valNode, minNode), f32Sub(maxNode, minNode)), f32Lit(0), f32Lit(1)),
            )
          : undefined
        return {
          preamble: [],
          isConst: false, needsFeatures: true, isVec4: true,
          expr: `mix(vec4f(${fmt(lr)}, ${fmt(lg)}, ${fmt(lb)}, ${fmt(la)}), vec4f(${fmt(hr)}, ${fmt(hg)}, ${fmt(hb)}, ${fmt(ha)}), clamp((${valExpr} - ${minExpr}) / (${maxExpr} - ${minExpr}), 0.0, 1.0))`,
          nodeExpr,
        }
      }
    }

    // ── Legacy: fill-[name] / fill-[.name] → auto palette (backward compat) ──
    if (ast.kind === 'FieldAccess' || (ast.kind === 'Identifier' && ast.name !== 'zoom')) {
      const wgsl = exprToWGSL(ast, fieldMap, fnEnv)
      // Phase 2.5 US-005 idiom — same shape as the explicit
      // categorical() path above; reuses featDataField when the
      // ast is a simple Identifier / FieldAccess (the only shapes
      // this fallback accepts).
      const fieldName = ast.kind === 'Identifier' ? ast.name : ast.field
      const fieldNode = featDataField(fieldName, fieldMap)
      const nodeExpr = fieldNode
        ? arrayIndex<'vec4<f32>'>(
            constRefVec4('CAT_PALETTE') as NodeLike<string>,
            u32Mod(toU32(fieldNode), u32Lit(20)),
            'vec4<f32>',
          )
        : undefined
      return {
        preamble: [generatePaletteWGSL()],
        isConst: false, needsFeatures: true, isVec4: true,
        expr: `CAT_PALETTE[u32(${wgsl}) % 20u]`,
        nodeExpr,
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
        // Phase 2.5 US-005 idiom — scale() emits the same WGSL shape
        // as gradient() (mix between two literal vec4 endpoints).
        // Reuses the same Node composition path.
        const valNode = simpleScalarNode(ast.args[0], fieldMap)
        const minNode = simpleScalarNode(ast.args[1], fieldMap)
        const maxNode = simpleScalarNode(ast.args[2], fieldMap)
        const nodeExpr = (valNode && minNode && maxNode)
          ? mix4(
              vec4fFromRgba(lowColor),
              vec4fFromRgba(highColor),
              clampF32(f32Div(f32Sub(valNode, minNode), f32Sub(maxNode, minNode)), f32Lit(0), f32Lit(1)),
            )
          : undefined
        return {
          preamble: [],
          isConst: false, needsFeatures: true, isVec4: true,
          expr: `mix(vec4f(${fmt(lr)}, ${fmt(lg)}, ${fmt(lb)}, ${fmt(la)}), vec4f(${fmt(hr)}, ${fmt(hg)}, ${fmt(hb)}, ${fmt(ha)}), clamp((${valExpr} - ${minExpr}) / (${maxExpr} - ${minExpr}), 0.0, 1.0))`,
          nodeExpr,
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
        // Phase 2.5 US-005 idiom (palette sample) — emit the
        // textureSampleLevel call as a real Node so the zoom-interp +
        // palette path (OFM Bright zoom-interpolated fills, etc.) flows
        // Node-emit at the marker substitution site.
        nodeExpr: emitColorGradientSampleNode(palette, gradientIdx) ?? undefined,
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
      // Phase 2.5 US-005 — Node-emit available for constant-opacity
      // (the most common path).
      nodeExpr: refF32('OPACITY'),
    }
  }

  if (value.kind === 'data-driven') {
    const fields = collectFields(value.expr.ast)
    fields.forEach(f => featureFields.add(f))
    const fieldMap = buildFieldMap(featureFields)
    const wgsl = exprToWGSL(value.expr.ast, fieldMap, fnEnv)
    // Phase 2.5 US-005 idiom (data-driven opacity, simple shapes) —
    // when the AST is an Identifier / FieldAccess / NumberLiteral,
    // build the f32 Node via featDataField / f32Lit. Complex AST
    // (arithmetic, builtins) needs the full DataExpr converter.
    return {
      preamble: [],
      needsUniform: false,
      needsFeatures: true,
      expr: wgsl,
      nodeExpr: simpleScalarNode(value.expr.ast, fieldMap) ?? undefined,
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
        // Phase 2.5 US-005 — Node parallel emission for the scalar
        // palette sample (opacity zoom-interp w/ palette path).
        nodeExpr: emitScalarGradientSampleNode(palette, idx) ?? undefined,
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

// Phase 2.5 US-005 — best-effort AST -> Node converter for the scalar
// shapes exprToWGSL handles cleanly:
//   - NumberLiteral   -> f32Lit(value)
//   - Identifier      -> featDataField(name, fieldMap) (when known)
//   - FieldAccess     -> featDataField(field, fieldMap) (when known)
//   - BinaryExpr +-*/ -> recursive f32Add/Sub/Mul/Div composition
// Returns null for shapes needing the full DataExpr converter
// (comparison / logical binops, builtin calls, pipe expressions);
// callers then route to the legacy wgslRaw path.
function simpleScalarNode(
  ast: import('../parser/ast').Expr,
  fieldMap: Map<string, number>,
): NodeLike<'f32'> | null {
  if (ast.kind === 'NumberLiteral') return f32Lit(ast.value)
  if (ast.kind === 'Identifier' && ast.name !== 'zoom') return featDataField(ast.name, fieldMap)
  if (ast.kind === 'FieldAccess') return featDataField(ast.field, fieldMap)
  if (ast.kind === 'BinaryExpr') {
    const left = simpleScalarNode(ast.left, fieldMap)
    const right = simpleScalarNode(ast.right, fieldMap)
    if (!left || !right) return null
    switch (ast.op) {
      case '+': return f32Add(left, right)
      case '-': return f32Sub(left, right)
      case '*': return f32Mul(left, right)
      case '/': return f32Div(left, right)
      default: return null // '%', comparison, logical → not supported here
    }
  }
  // Phase 2.5 US-005 — recognise the WGSL-builtin scalar fn calls
  // exprToWGSL maps through the WGSL_BUILTINS table (clamp, min,
  // max, abs, sqrt, floor, ceil, sin, cos, ...). Returns a typed
  // call op when every arg also resolves to a simple scalar Node.
  if (ast.kind === 'FnCall' && ast.callee.kind === 'Identifier') {
    const SIMPLE_BUILTINS = new Set([
      'clamp', 'min', 'max', 'abs', 'sqrt', 'floor', 'ceil', 'round',
      'log', 'log2', 'exp', 'exp2', 'pow',
      'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
    ])
    if (SIMPLE_BUILTINS.has(ast.callee.name)) {
      const args: NodeLike<'f32'>[] = []
      for (const arg of ast.args) {
        const n = simpleScalarNode(arg, fieldMap)
        if (!n) return null
        args.push(n)
      }
      return {
        expr: {
          op: 'call',
          type: { kind: 'scalar', scalar: 'f32' },
          fn: ast.callee.name,
          args: args.map(a => a.expr),
        },
      } as NodeLike<'f32'>
    }
  }
  return null
}

// Phase 2.5 US-005 idiom #1+#2 — recognise paths whose ColorResult.expr
// and OpacityResult.expr are PURE VARREFS (single identifier optionally
// dotted, e.g. `FILL_COLOR`, `u.fill_color`, `OPACITY`, `u.opacity`).
// In those cases the legacy `vec4f(<color>.rgb, <color>.a * <opacity>)`
// composition is structurally equivalent to a real DSL
// `composeFillVec4(varref(color), varref(opacity))` Node, so the
// migration produces the same WGSL at the marker substitution site
// with no per-arm logic change.
//
// Covers: constant fill / stroke (FILL_COLOR / STROKE_COLOR), time-
// interpolated (u.fill_color / u.stroke_color), and the legacy
// fallback path that returns `u.<prefix>_color` (line 362).
// Any path whose expr embeds arithmetic / function calls / member
// accesses beyond a single dotted name falls back to wgslRaw.

// Single dotted-identifier check: `name` or `obj.field`. Rejects WGSL
// expression text (`vec4f(...)`, `unpack4x8unorm(...)`, `mix(a, b, t)`,
// data-driven binop strings, etc.).
const PURE_VARREF_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/

function tryComposeFillNodeFromVarrefs(
  color: ColorResult,
  opacity: OpacityResult,
): NodeLike<'vec4<f32>'> | null {
  if (!color.isVec4) return null
  if (!PURE_VARREF_RE.test(color.expr)) return null
  if (!PURE_VARREF_RE.test(opacity.expr)) return null
  // Color is always a vec4 here (isVec4=true guard); opacity is f32.
  // refF32 emits varref to either `OPACITY` (const decl) or `u.opacity`
  // (uniform field) — both pass the PURE_VARREF_RE check.
  // For the color varref, the name might be either `FILL_COLOR` (const
  // decl) or `u.fill_color` (uniform field). constRefVec4 emits a
  // `constref` op while the runtime treats it as a varref — same emit
  // shape, so the WGSL output matches the legacy `<name>` text either way.
  return composeFillVec4(constRefVec4(color.expr), refF32(opacity.expr))
}

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
