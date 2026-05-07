// ═══ Extrude expression evaluator ═════════════════════════════════
//
// Thin wrapper around the compiler's `evaluate()` that coerces the
// result to a finite positive number (or null). Kept as a tiny
// helper so callers don't have to repeat the type-check + finite-
// check + sign-check at every call site. The MVT worker is already
// importing decode / decompose / compile from `@xgis/compiler`, so
// pulling in `evaluate` adds no new modules to the worker bundle.
//
// Returning null means "the expression didn't yield a usable height
// for this feature" — caller falls back to the layer's fallback
// height. NaN, Infinity, zero, negative numbers, strings, booleans,
// nulls, and unsupported AST kinds all collapse to that same null.

import { evaluate } from '@xgis/compiler'

export type ExtrudeAst = unknown // serialized AST node, structurally typed by evaluate()

/** Evaluate an extrude AST against a feature property bag. Returns
 *  a finite positive number, or null when the expression is missing
 *  required fields / divides by zero / produces a non-numeric
 *  value. The full compiler evaluator handles the entire AST surface
 *  (literals, FieldAccess, BinaryExpr, UnaryExpr, FnCall, MatchBlock,
 *  ConditionalExpr, ArrayLiteral / ArrayAccess, PipeExpr); anything
 *  the user can write inside `fill: ...` works inside `extrude: ...`
 *  too. */
export function evalExtrudeExpr(node: ExtrudeAst, props: Record<string, unknown>): number | null {
  if (!node || typeof node !== 'object') return null
  // The cast is structural — evaluate() expects an AST.Expr but
  // accepts anything matching the node-kind dispatch shape we get
  // from the parser. Threading the full type all the way to the
  // worker would force the worker to re-export the compiler's AST
  // surface; using `unknown` at the boundary is functionally
  // equivalent and keeps the call sites straightforward.
  const v = evaluate(node as never, props)
  if (typeof v !== 'number') return null
  if (!Number.isFinite(v) || v <= 0) return null
  return v
}
