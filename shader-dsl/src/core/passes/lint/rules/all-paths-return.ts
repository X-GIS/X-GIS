import type { Stmt } from '../../../ir'
import type { LintRule } from '../engine'

/** True iff the last reachable Stmt guarantees an exit. A body with a raw/placeholder
 *  Stmt is treated as may-return (the polygon composer injects returns via a swap). */
function alwaysReturns(body: readonly Stmt[]): boolean {
  if (body.some((s) => s.s === 'raw' || s.s === 'placeholder')) return true
  if (body.length === 0) return false
  return stmtTerminates(body[body.length - 1])
}
function stmtTerminates(s: Stmt): boolean {
  switch (s.s) {
    case 'return':
      return true
    case 'discard':
      return true
    case 'if':
      return (
        s.elseBody !== undefined &&
        s.arms.every((arm) => alwaysReturns(arm.body)) &&
        alwaysReturns(s.elseBody)
      )
    case 'switch':
      return (
        s.defaultBody !== undefined &&
        s.cases.every((c) => alwaysReturns(c.body)) &&
        alwaysReturns(s.defaultBody)
      )
    default:
      return false
  }
}

/** A non-void function must return on every path. */
export const allPathsReturn: LintRule = {
  id: 'all-paths-return',
  description: 'a non-void fn must return on every path',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => ({
    Func(f) {
      if (f.ret.kind !== 'void' && !alwaysReturns(f.body)) {
        ctx.report(`fn '${f.name}' returns non-void but a code path falls through without return`, {
          fn: f.name,
        })
      }
    },
  }),
}
