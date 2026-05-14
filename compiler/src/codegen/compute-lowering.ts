// ═══════════════════════════════════════════════════════════════════
// IR/AST → ComputeKernel spec adapter
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4 sub-step. Bridges the two halves we've shipped so far:
//
//   paint-routing.ts → "this paint value belongs on the compute path"
//   compute-gen.ts   → "emit WGSL for this spec"
//
// Without an adapter the routing module decides "compute-feature" but
// the emitter only takes hand-rolled MatchEmitSpec / TernaryEmitSpec
// objects. This file is the pure analyzer that walks one ColorValue
// (or one DataExpr) and produces the spec — no GPU, no IR mutation.
//
// Two lowerings:
//
//   ColorValue.kind === 'conditional'
//       branches: [{ field, value }], fallback: ColorValue
//     →  TernaryEmitSpec
//        fields:   [...unique field names...]
//        branches: each branch becomes a WGSL `v_<field> != 0.0` test
//        defaultColorHex: fallback (must itself be constant)
//
//   ColorValue.kind === 'data-driven', expr.ast is match() FnCall
//       FnCall { callee: 'match', args: [FieldAccess], matchBlock }
//     →  MatchEmitSpec
//        fieldName: FieldAccess.field
//        arms: each non-default arm with resolved hex
//        defaultColorHex: the `_` arm
//
// Returns null when the shape doesn't fit either lowering — caller
// (eventual emit-commands integration) must fall back to the legacy
// shader-gen inline path. The router cannot promise compute-ness
// because some 'conditional' or 'data-driven' values nest more
// complex expressions; the adapter's null is the runtime's signal
// to use the inline fragment emit.

import type { Expr } from '../parser/ast'
import type { ColorValue, DataExpr } from '../ir/render-node'
import { rgbaToHex } from '../ir/render-node'
import { resolveColor } from '../tokens/colors'
import type { MatchEmitSpec, TernaryEmitSpec } from './compute-gen'

/** Lower a `conditional` ColorValue (branches × fallback) into a
 *  TernaryEmitSpec. Each branch's `field` becomes a feature property
 *  read (`v_<field>`), and a branch fires when that property is
 *  non-zero — matching the existing `paint-shape-resolve` semantics
 *  for boolean-flag fields. Returns null if any branch value or the
 *  fallback isn't a constant colour (compute path can't materialise
 *  a nested data-driven expression in a single kernel — that case
 *  is the multi-kernel composition future P4-6 sub-step).
 */
export function lowerConditionalColorToTernary(
  value: Extract<ColorValue, { kind: 'conditional' }>,
): TernaryEmitSpec | null {
  const seen = new Set<string>()
  const fields: string[] = []
  const branches: { pred: string; colorHex: string }[] = []

  for (const branch of value.branches) {
    if (branch.value.kind !== 'constant') return null
    const colorHex = rgbaToHex(branch.value.rgba)
    if (!seen.has(branch.field)) {
      seen.add(branch.field)
      fields.push(branch.field)
    }
    branches.push({ pred: `v_${branch.field} != 0.0`, colorHex })
  }

  if (value.fallback.kind !== 'constant') return null
  const defaultColorHex = rgbaToHex(value.fallback.rgba)

  return { fields, branches, defaultColorHex }
}

/** Lower a `data-driven` ColorValue whose AST is a match() FnCall
 *  into a MatchEmitSpec. The match() must take a single FieldAccess
 *  argument with `object === null` (implicit current feature) — any
 *  other shape (nested function call, chained pipe) is too complex
 *  for the current single-field-stride compute kernel and returns
 *  null. Arms' values must be ColorLiteral / Identifier resolving
 *  to a named colour; non-resolvable arms are skipped (mirrors
 *  shader-gen's `resolveColorFromAST` behaviour exactly so cross-
 *  path category IDs stay aligned). */
export function lowerMatchColorToMatch(
  expr: DataExpr,
): MatchEmitSpec | null {
  const ast = expr.ast
  if (ast.kind !== 'FnCall') return null
  if (ast.callee.kind !== 'Identifier' || ast.callee.name !== 'match') return null
  if (!ast.matchBlock) return null
  if (ast.args.length !== 1) return null

  const fieldExpr = ast.args[0]!
  if (fieldExpr.kind !== 'FieldAccess' || fieldExpr.object !== null) return null

  const arms: { pattern: string; colorHex: string }[] = []
  let defaultColorHex: string | null = null

  for (const arm of ast.matchBlock.arms) {
    const hex = resolveColorOfAST(arm.value)
    if (!hex) continue
    if (arm.pattern === '_') {
      defaultColorHex = hex
    } else {
      arms.push({ pattern: arm.pattern, colorHex: hex })
    }
  }

  if (defaultColorHex === null) {
    // No explicit default — fall through transparent. Matches what
    // merge-layers synthesises for compound fills (`#00000000`).
    defaultColorHex = '#00000000'
  }

  return { fieldName: fieldExpr.field, arms, defaultColorHex }
}

/** Pure-string resolver for arm value ASTs. Accepts the shapes the
 *  compiler produces:
 *
 *    - Identifier 'cornflowerblue'           → CSS named colour
 *    - StringLiteral '"cornflowerblue"'      → same
 *    - StringLiteral '"rgb(255,0,0)"'        → CSS rgb/hsl function
 *    - ColorLiteral  '#f00' / '#f00f' /
 *                    '#ff0000' / '#ff0000ff' → verbatim CSS hex
 *
 *  All four CSS hex shapes pass through (3 / 4 / 6 / 8 digits) so
 *  user-authored styles like `match(.class) { fire -> #f00 }` work
 *  on the compute path the same way they work on the inline-shader
 *  path. Anything else (compound expressions, var refs) returns
 *  null and the runtime falls back to inline-fragment emit. */
function resolveColorOfAST(node: Expr): string | null {
  if (node.kind === 'ColorLiteral') {
    const v = node.value
    if (typeof v === 'string' && /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) {
      return v
    }
    return null
  }
  if (node.kind === 'Identifier') {
    const hex = resolveColor(node.name)
    return hex ?? null
  }
  if (node.kind === 'StringLiteral') {
    const hex = resolveColor(node.value)
    return hex ?? null
  }
  return null
}
