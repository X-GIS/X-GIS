// ═══ Shader Variant Generator ═══
// Generates per-layer WGSL shader variants based on IR analysis.
// Three specialization axes: projection × value constants × feature data.

import type { RenderNode, ColorValue, OpacityValue } from '../ir/render-node'
import { rgbaToHex } from '../ir/render-node'
import { astToNode, collectFields, type WGSLFnEnv } from './wgsl-expr'
import { buildCatPaletteConst, CAT_PALETTE_SIZE } from './categorical-encoder'
import type { Palette } from './palette'
import {
  emitColorGradientSampleNode,
  emitScalarGradientSampleNode,
  buildScalarSampleFunc,
  buildPaletteBindingDecls,
  type ScalarPaletteMode,
} from './palette-emit'
import type { ShaderVariant, ColorResult, OpacityResult, PreambleModule } from './shader-gen-types'
import type { NodeLike } from './node-types'
import type { ConstDecl, BindingDecl, FuncDecl, Expr } from '@xgis/shader-dsl'
import { vec4fT, f32T } from '@xgis/shader-dsl'
import {
  composeFillVec4, constRefVec4, varRefVec4, refF32,
  toU32, toI32, u32Lit, u32Mod, arrayIndex,
  mix4, clampF32, f32Sub, f32Div, f32Lit, vec4f, vec4fFromRgba, matchVec4,
} from './_util/node-builders'
import {
  buildFieldMap,
  matchArmsKey,
  resolveColorFromAST,
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
  // Single-emit: every colour / opacity arm produces a real DSL Node, so fill /
  // stroke compose to a Node directly. A `kind: 'none'` fill stays the default-
  // uniform sentinel — a literal `null` paired with `fillIsDefault: true` below;
  // the runtime checks that flag (NOT the field's contents) and combines it with
  // the `cachedFillColor[3] <= 0.005` test to skip the entire fill draw, the
  // right behaviour for stroke-only layers (no fill draw → no pick write, so
  // picks fall through to whatever drew underneath).
  const fillExprNode = composeColorOpacityNode(fillResult, opacityResult)
  const strokeExprNode = composeColorOpacityNode(strokeResult, opacityResult)
  const fillExpr: NodeLike<'vec4<f32>'> | null =
    node.fill.kind === 'none' ? null : fillExprNode
  const strokeExpr: NodeLike<'vec4<f32>'> | null = strokeExprNode

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
      isConst: true, needsFeatures: false,
      nodeExpr: constRefVec4(`${prefix}_COLOR`),
    }
  }

  if (value.kind === 'constant') {
    return {
      preamble: [vec4ConstDecl(`${prefix}_COLOR`, value.rgba)],
      isConst: true, needsFeatures: false,
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
      isConst: false, needsFeatures: false,
      nodeExpr: varRefVec4(uniformName),
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
      // categorical(field) → CAT_PALETTE[u32(field) % CAT_PALETTE_SIZE].
      // `astToNode` converts ANY field-argument AST shape (direct FieldAccess /
      // Identifier, but also arithmetic / builtin-call / pipe) to IR, so the
      // Node path always carries the colour — no string fallback. The modulo
      // bound is single-sourced from CAT_PALETTE_SIZE (the palette array length)
      // so it can never diverge from buildCatPaletteConst's array (#724).
      const fieldNode = astToNode(fieldExpr, fieldMap, fnEnv)
      const nodeExpr = arrayIndex<'vec4<f32>'>(
        constRefVec4('CAT_PALETTE') as NodeLike<string>,
        u32Mod(toU32(fieldNode), u32Lit(CAT_PALETTE_SIZE)),
        'vec4<f32>',
      )
      return {
        preamble: [buildCatPaletteConst()],
        isConst: false, needsFeatures: true,
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
        isConst: false, needsFeatures: true,
        // Legacy string field (unused for output now that nodeExpr owns the
        // match — buildFillExpr's string path is only reached when nodeExpr is
        // absent). Carries the fallback colour as a defensive standalone value.
        categoryOrder,
        nodeExpr,
        // Disambiguates the variant cache: two compounds over the same field
        // with different value→colour mappings hash differently here.
        matchNode: nodeExpr,
      } as ColorResult
    }

    // ── gradient(field, min, max, colorLow, colorHigh) → mix() ──
    if (ast.kind === 'FnCall' && ast.callee.kind === 'Identifier' && ast.callee.name === 'gradient' && ast.args.length === 5) {
      const lowColor = resolveColorFromAST(ast.args[3])
      const highColor = resolveColorFromAST(ast.args[4])
      if (lowColor && highColor) {
        // Build mix4(low, high, clamp(...)) Node end-to-end. `astToNode`
        // converts any val/min/max AST shape (compound binops, builtins,
        // pipes, user-fn inlining) to IR.
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
          isConst: false, needsFeatures: true,
          nodeExpr,
        }
      }
    }

    // ── Legacy: fill-[name] / fill-[.name] → auto palette (backward compat) ──
    if (ast.kind === 'FieldAccess' || (ast.kind === 'Identifier' && ast.name !== 'zoom')) {
      // Same shape as the explicit categorical() path above; `astToNode`
      // converts the field AST (Identifier / FieldAccess here) to IR, so the
      // Node path always carries it.
      const fieldNode = astToNode(ast, fieldMap, fnEnv)
      const nodeExpr = arrayIndex<'vec4<f32>'>(
        constRefVec4('CAT_PALETTE') as NodeLike<string>,
        u32Mod(toU32(fieldNode), u32Lit(CAT_PALETTE_SIZE)),
        'vec4<f32>',
      )
      return {
        preamble: [buildCatPaletteConst()],
        isConst: false, needsFeatures: true,
        nodeExpr,
      }
    }

    // ── Legacy: scale(field, min, max, colorLow, colorHigh) ──
    if (ast.kind === 'FnCall' && ast.callee.kind === 'Identifier' && ast.callee.name === 'scale' && ast.args.length === 5) {
      const lowColor = resolveColorFromAST(ast.args[3])
      const highColor = resolveColorFromAST(ast.args[4])
      if (lowColor && highColor) {
        // scale() emits the same shape as gradient() (mix between two literal
        // vec4 endpoints) — same Node composition, `astToNode` for any
        // val/min/max AST shape.
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
          isConst: false, needsFeatures: true,
          nodeExpr,
        }
      }
    }

    // Default: scalar data-driven expression → greyscale vec4(s, s, s, opacity).
    return {
      preamble: [],
      isConst: false, needsFeatures: true,
      scalarNodeExpr: astToNode(ast, fieldMap, fnEnv),
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
        isConst: false, needsFeatures: false,
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
    isConst: false, needsFeatures: false,
    nodeExpr: varRefVec4(`u.${prefix.toLowerCase()}_color`),
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
      // Phase 2.5 US-005 — Node-emit available for constant-opacity
      // (the most common path).
      nodeExpr: refF32('OPACITY'),
    }
  }

  if (value.kind === 'data-driven') {
    const fields = collectFields(value.expr.ast)
    fields.forEach(f => featureFields.add(f))
    const fieldMap = buildFieldMap(featureFields)
    // Data-driven opacity → f32 Node via `astToNode` (any AST shape).
    return {
      preamble: [],
      needsUniform: false,
      needsFeatures: true,
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
    nodeExpr: refF32('u.opacity'),
  }
}

// ═══ Expression builders ═══

/** Compose a colour ColorResult + opacity OpacityResult into the final
 *  fill / stroke vec4 Node. Every colour arm carries either a vec4 `nodeExpr`
 *  (constant, categorical, gradient, scale, match, palette, uniform) or a
 *  scalar `scalarNodeExpr` (data-driven greyscale), and every opacity arm a
 *  scalar `nodeExpr` — so this always returns a Node (no string fallback):
 *
 *    - vec4 colour → `vec4(colour.rgb, colour.a * opacity)` via composeFillVec4.
 *    - scalar colour → `vec4(s, s, s, opacity)` (greyscale: s drives rgb). */
function composeColorOpacityNode(
  color: ColorResult,
  opacity: OpacityResult,
): NodeLike<'vec4<f32>'> | null {
  const opacityNode = opacity.nodeExpr
  if (!opacityNode) return null
  if (color.scalarNodeExpr) {
    const s = color.scalarNodeExpr
    return vec4f(s, s, s, opacityNode)
  }
  if (color.nodeExpr) return composeFillVec4(color.nodeExpr, opacityNode)
  return null
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
