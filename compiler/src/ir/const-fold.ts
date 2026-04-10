// ═══ Constant Folder ═══
// Evaluates expressions that contain only literals (no field access, no zoom).
// Reuses the existing evaluate() function with an empty props bag.

import type * as AST from '../parser/ast'
import { evaluate } from '../eval/evaluator'
import { classifyExpr, type FnEnv } from './classify'

/**
 * Attempt to fold a constant expression at compile time.
 * Returns the folded value, or null if the expression is not constant.
 */
export function constFold(expr: AST.Expr, fnEnv?: FnEnv): { value: unknown } | null {
  // Only fold expressions classified as constant
  if (classifyExpr(expr, fnEnv) !== 'constant') return null

  try {
    const result = evaluate(expr, {}, fnEnv)
    if (result !== null && result !== undefined) {
      return { value: result }
    }
  } catch {
    // Can't fold (e.g., division by zero edge case) — leave for runtime
  }
  return null
}
