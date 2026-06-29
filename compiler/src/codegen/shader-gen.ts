// ═══ Shader Variant Generator ═══
// Generates per-layer WGSL shader variants based on IR analysis.
// Three specialization axes: projection × value constants × feature data.

import type { RenderNode, ColorValue, OpacityValue } from '../ir/render-node'
import { rgbaToHex } from '../ir/render-node'
import { exprToWGSL, astToNode, collectFields, type WGSLFnEnv } from './wgsl-expr'
import { buildCatPaletteConst } from './categorical-encoder'
import type { Palette } from './palette'
import {
  emitColorGradientSample,
  emitColorGradientSampleNode,
  emitScalarGradientSample,
  emitScalarGradientSampleNode,
  buildScalarSampleFunc,
  buildPaletteBindingDecls,
  type ScalarPaletteMode,
} from './palette-emit'
import type { ShaderVariant, ColorResult, OpacityResult, PreambleModule } from './shader-gen-types'
import { wgslRaw } from './node-types'
import type { NodeLike } from './node-types'
import type { ConstDecl, BindingDecl, FuncDecl, Expr } from '@xgis/shader-dsl'
import { vec4fT, f32T } from '@xgis/shader-dsl'
import {
  composeFillVec4, constRefVec4, refF32,
  toU32, toI32, u32Lit, u32Mod, arrayIndex, featDataField,
  mix4, clampF32, f32Sub, f32Div, f32Lit, vec4fFromRgba, matchVec4,
} from './_util/node-builders'
import {
  buildFieldMap,
  matchArmsKey,
  resolveColorFromAST,
  fmt,
} from './shader-gen-helpers'

export type { ShaderVariant } from './shader-gen-types'

/** Build a `vec4<f32>` module const from an RGBA tuple (the FILL/STROKE_COLOR
 *  specialised constants), authored as an IR literal expression. */
function vec4ConstDecl(name: string, rgba: readonly [number, number, number, number]): ConstDecl {
  return { name, type: vec4fT, wgslValue: 0, cpuValue: 0, valueExpr: vec4fFromRgba(rgba).expr as Expr }
}

/** Build a scalar `f32` module const (OPACITY) — the dual-precision form. */
function f32ConstDecl(name: string, value: number): ConstDecl {
  return { name, type: f32T, wgslValue: value, cpuValue: value }
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
  const consts: ConstDecl[] = []
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
  consts.push(...fillResult.preamble)
  if (!fillResult.isConst) uniformFields.push('fill_color')
  if (fillResult.needsFeatures) needsFeatureBuffer = true
  if (fillResult.paletteGradientIdx !== undefined) {
    paletteColorGradients.push(fillResult.paletteGradientIdx)
  }

  // ── Stroke ──
  const strokeResult = processColorValue(node.stroke.color, 'STROKE', allFeatureFields, fnEnv, palette)
  consts.push(...strokeResult.preamble)
  if (!strokeResult.isConst) uniformFields.push('stroke_color')
  if (strokeResult.needsFeatures) needsFeatureBuffer = true
  if (strokeResult.paletteGradientIdx !== undefined) {
    paletteColorGradients.push(strokeResult.paletteGradientIdx)
  }

  // ── Opacity ──
  const opacityResult = processOpacity(node.opacity, allFeatureFields, fnEnv, palette)
  consts.push(...opacityResult.preamble)
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
  const fillExprNode = composeColorOpacityNode(fillResult, opacityResult)
  const strokeExprNode = composeColorOpacityNode(strokeResult, opacityResult)
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
    // keys but DIFFERENT shader bodies — the matchExpr cases differ.
    // Without this, the variant cache returns the FIRST compiled
    // compound's pipeline for the SECOND compound's draws → roads end
    // up rendered with landuse colours (or vice versa). Hashing the
    // match Node's structural JSON disambiguates them.
    + matchArmsKey(fillResult.matchNode, strokeResult.matchNode)

  // Aggregate categoryOrder from fill + stroke results. Both code
  // paths sort patterns alphabetically, so a field used by BOTH fill
  // and stroke matches gets the same order (later spread overrides
  // identical values harmlessly). Opacity doesn't use match() today.
  const categoryOrder: Record<string, string[]> = {
    ...(fillResult.categoryOrder ?? {}),
    ...(strokeResult.categoryOrder ?? {}),
  }

  // Palette binding declarations + scalar-sample helper fn, as IR decls, when
  // the variant actually samples either atlas. Empty for non-palette variants.
  const bindings: BindingDecl[] = []
  const funcs: FuncDecl[] = []
  if (palette && (paletteColorGradients.length > 0 || paletteScalarGradients.length > 0)) {
    bindings.push(...buildPaletteBindingDecls(palette))
    if (paletteScalarGradients.length > 0) {
      const helper = buildScalarSampleFunc(palette, scalarPaletteMode)
      if (helper) funcs.push(helper)
    }
  }
  const preamble: PreambleModule = { consts, bindings, funcs }

  return {
    key,
    preamble,
    fillExpr,
    strokeExpr,
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
      preamble: [vec4ConstDecl(`${prefix}_COLOR`, [0, 0, 0, 0])],
      isConst: true, needsFeatures: false, isVec4: true,
      expr: `${prefix}_COLOR`,
      nodeExpr: constRefVec4(`${prefix}_COLOR`),
    }
  }

  if (value.kind === 'constant') {
    return {
      preamble: [vec4ConstDecl(`${prefix}_COLOR`, value.rgba)],
      isConst: true, needsFeatures: false, isVec4: true,
      expr: `${prefix}_COLOR`,
      nodeExpr: constRefVec4(`${prefix}_COLOR`),
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
        preamble: [buildCatPaletteConst()],
        isConst: false, needsFeatures: true, isVec4: true,
        expr: `CAT_PALETTE[u32(${wgsl}) % 20u]`,
        nodeExpr,
      }
    }

    // ── match(field) { "val" -> color, ... } → matchExpr IR node ──
    if (ast.kind === 'FnCall' && ast.callee.kind === 'Identifier' && ast.callee.name === 'match' && ast.matchBlock) {
      const fieldExpr = ast.args[0]
      const arms = ast.matchBlock.arms

      // Fallback (the `_` arm) — defaults to mid-grey when the style omits it.
      let fallbackRgba: [number, number, number, number] = [0.5, 0.5, 0.5, 1.0]
      for (const arm of arms) {
        if (arm.pattern !== '_') continue
        const rgba = resolveColorFromAST(arm.value)
        if (rgba) fallbackRgba = rgba
      }

      // Sort patterns alphabetically to match runtime category ID assignment
      // (the packer maps string→ID in this same order; the IDs index the cases).
      const sortedPatterns = arms
        .filter(a => a.pattern !== '_')
        .map(a => a.pattern)
        .sort()
      const rgbaByPattern = new Map<string, [number, number, number, number]>()
      for (const arm of arms) {
        if (arm.pattern === '_') continue
        const rgba = resolveColorFromAST(arm.value)
        if (rgba) rgbaByPattern.set(arm.pattern, rgba)
      }

      // Scrutinee is the feature field cast to i32 — same shape as the compute
      // match kernel (`toI32(featData.at(fid))`). Each case is `[id, color]`;
      // the backend's lowerModule hoists the matchExpr into a var + switch.
      const cases = sortedPatterns
        .map((pat, i) => [i, rgbaByPattern.get(pat)] as const)
        .filter((c): c is readonly [number, [number, number, number, number]] => c[1] !== undefined)
        .map(([i, rgba]) => [i, vec4fFromRgba(rgba)] as const)
      const nodeExpr = matchVec4(
        toI32(astToNode(fieldExpr, fieldMap, fnEnv)),
        cases,
        vec4fFromRgba(fallbackRgba),
      )

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
        // Legacy string field (unused for output now that nodeExpr owns the
        // match — buildFillExpr's string path is only reached when nodeExpr is
        // absent). Carries the fallback colour as a defensive standalone value.
        expr: `vec4f(${fmt(fallbackRgba[0])}, ${fmt(fallbackRgba[1])}, ${fmt(fallbackRgba[2])}, ${fmt(fallbackRgba[3])})`,
        categoryOrder,
        nodeExpr,
        // Disambiguates the variant cache: two compounds over the same field
        // with different value→colour mappings hash differently here.
        matchNode: nodeExpr,
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
        // Build mix4(low, high, clamp(...)) Node end-to-end. `astToNode`
        // converts any val/min/max AST shape (compound binops, builtins,
        // pipes, user-fn inlining) to IR, byte-consistent with the `expr`
        // string (both go through the same AST→Node path).
        const valNode = astToNode(ast.args[0], fieldMap, fnEnv)
        const minNode = astToNode(ast.args[1], fieldMap, fnEnv)
        const maxNode = astToNode(ast.args[2], fieldMap, fnEnv)
        const nodeExpr = mix4(
          vec4fFromRgba(lowColor),
          vec4fFromRgba(highColor),
          clampF32(f32Div(f32Sub(valNode, minNode), f32Sub(maxNode, minNode)), f32Lit(0), f32Lit(1)),
        )
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
        preamble: [buildCatPaletteConst()],
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
        // scale() emits the same WGSL shape as gradient() (mix between
        // two literal vec4 endpoints) — same Node composition path,
        // `astToNode` for any val/min/max AST shape.
        const valNode = astToNode(ast.args[0], fieldMap, fnEnv)
        const minNode = astToNode(ast.args[1], fieldMap, fnEnv)
        const maxNode = astToNode(ast.args[2], fieldMap, fnEnv)
        const nodeExpr = mix4(
          vec4fFromRgba(lowColor),
          vec4fFromRgba(highColor),
          clampF32(f32Div(f32Sub(valNode, minNode), f32Sub(maxNode, minNode)), f32Lit(0), f32Lit(1)),
        )
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
      preamble: [f32ConstDecl('OPACITY', value.value)],
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
    // Data-driven opacity → f32 Node via `astToNode` (any AST shape,
    // byte-consistent with the `expr` string built from the same path).
    return {
      preamble: [],
      needsUniform: false,
      needsFeatures: true,
      expr: wgsl,
      nodeExpr: astToNode(value.expr.ast, fieldMap, fnEnv),
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

/** Compose a colour ColorResult + opacity OpacityResult into the final
 *  `vec4(color.rgb, color.a * opacity)` Node, preferring real Node exprs.
 *
 *  - When the colour carries a real `nodeExpr` (constant, categorical,
 *    gradient, scale, match, …): compose it with the opacity's `nodeExpr`,
 *    or — when opacity hasn't migrated to a Node yet (the `u.opacity`
 *    uniform path) — synthesise a varref Node from its pure-varref string.
 *    This keeps match()/data-driven fills on the Node path regardless of
 *    the opacity arm, so the matchExpr is never stranded in the dead
 *    legacy string path.
 *  - Otherwise fall back to the pure-varref pairing (constant / time-
 *    interpolated / default-uniform colours whose `expr` is a bare name). */
function composeColorOpacityNode(
  color: ColorResult,
  opacity: OpacityResult,
): NodeLike<'vec4<f32>'> | null {
  if (color.nodeExpr) {
    const opacityNode = opacity.nodeExpr
      ?? (PURE_VARREF_RE.test(opacity.expr) ? refF32(opacity.expr) : null)
    return opacityNode ? composeFillVec4(color.nodeExpr, opacityNode) : null
  }
  return tryComposeFillNodeFromVarrefs(color, opacity)
}

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
