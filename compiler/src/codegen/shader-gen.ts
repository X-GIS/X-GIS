// ═══ Shader Variant Generator ═══
// Generates per-layer WGSL shader variants based on IR analysis.
// Three specialization axes: projection × value constants × feature data.

import type { RenderNode, ColorValue, OpacityValue } from '../ir/render-node'
import { rgbaToHex, hexToRgba } from '../ir/render-node'
import { exprToWGSL, collectFields, type WGSLFnEnv } from './wgsl-expr'
import { generatePaletteWGSL } from './categorical-encoder'
import { resolveColor } from '../tokens/colors'

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
  /** Whether a storage buffer is needed for per-feature data */
  needsFeatureBuffer: boolean
  /** Fields needed from feature data (for storage buffer layout) */
  featureFields: string[]
  /** Which uniform fields are still needed (not inlined) */
  uniformFields: string[]
}

/**
 * Generate a shader variant for a RenderNode.
 * Determines what can be inlined as constants vs what needs uniforms/storage.
 */
export function generateShaderVariant(
  node: RenderNode,
  fnEnv?: WGSLFnEnv,
): ShaderVariant {
  const preambleLines: string[] = []
  const uniformFields: string[] = ['mvp', 'proj_params']
  const allFeatureFields = new Set<string>()
  let needsFeatureBuffer = false

  // ── Fill ──
  const fillResult = processColorValue(node.fill, 'FILL', allFeatureFields, fnEnv)
  preambleLines.push(...fillResult.preamble)
  if (!fillResult.isConst) uniformFields.push('fill_color')
  if (fillResult.needsFeatures) needsFeatureBuffer = true

  // ── Stroke ──
  const strokeResult = processColorValue(node.stroke.color, 'STROKE', allFeatureFields, fnEnv)
  preambleLines.push(...strokeResult.preamble)
  if (!strokeResult.isConst) uniformFields.push('stroke_color')
  if (strokeResult.needsFeatures) needsFeatureBuffer = true

  // ── Opacity ──
  const opacityResult = processOpacity(node.opacity, allFeatureFields, fnEnv)
  preambleLines.push(...opacityResult.preamble)
  if (opacityResult.needsUniform) uniformFields.push('opacity')
  if (opacityResult.needsFeatures) needsFeatureBuffer = true

  // ── Build final expressions ──
  const fillExpr = buildFillExpr(fillResult, opacityResult)
  const strokeExpr = buildStrokeExpr(strokeResult, opacityResult)

  // ── Cache key ──
  const featureFields = [...allFeatureFields].sort()
  const key = buildKey(node, fillResult, strokeResult, opacityResult, featureFields)

  return {
    key,
    preamble: preambleLines.join('\n'),
    fillExpr,
    strokeExpr,
    fillPreamble: fillResult.matchPreamble,
    needsFeatureBuffer,
    featureFields,
    uniformFields,
  }
}

// ═══ Value processing ═══

interface ColorResult {
  preamble: string[]
  isConst: boolean
  needsFeatures: boolean
  isVec4: boolean  // true if expr already returns vec4f (categorical/gradient)
  expr: string // WGSL expression for the color
  matchPreamble?: string // if-else chain for match() — injected before return in fragment
}

function processColorValue(
  value: ColorValue,
  prefix: string,
  featureFields: Set<string>,
  fnEnv?: WGSLFnEnv,
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

      return {
        preamble: [],
        isConst: false, needsFeatures: true, isVec4: true,
        expr: `/* match */ ${varName}`,
        matchPreamble: ifElse,
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

  // conditional, zoom-interpolated → fall back to uniform
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
}

function processOpacity(
  value: OpacityValue,
  featureFields: Set<string>,
  fnEnv?: WGSLFnEnv,
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

  // zoom-interpolated → uniform (CPU interpolates per frame)
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
  return null
}

function fmt(n: number): string {
  const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0')
  return s
}
