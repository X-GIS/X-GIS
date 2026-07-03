// ═══ Shader DSL — algebraic simplification pass (Optimization context) ═══
//
// Rewrites IEEE-sound identities on scalar/vector arithmetic: x+0, 0+x, x-0,
// x*1, 1*x, x/1. These hold for all finite values (the −0 / NaN / Inf edge
// cases are the only divergences, and shader math does not traffic in them).
//
// NOT applied: x*0 -> 0 and 0*x -> 0 — unsound for Inf/NaN (Inf*0 = NaN). That
// rewrite needs an explicit fast-math opt-in (a later flag), not the default.

import type { Expr, ModuleDecl } from '../../ir'
import { mapModuleExprs } from './ir-transform'

const isLit = (e: Expr, v: number): boolean =>
  e.op === 'lit' && typeof e.value === 'number' && e.value === v

function simplifyNode(e: Expr): Expr {
  if (e.op !== 'binop') return e
  switch (e.bop) {
    case '+':
      if (isLit(e.b, 0)) return e.a
      if (isLit(e.a, 0)) return e.b
      break
    case '-':
      if (isLit(e.b, 0)) return e.a
      break // x - 0 -> x (NOT 0 - x)
    case '*':
      if (isLit(e.b, 1)) return e.a
      if (isLit(e.a, 1)) return e.b
      break
    case '/':
      if (isLit(e.b, 1)) return e.a
      break // x / 1 -> x (NOT 1 / x)
  }
  return e
}

/** Apply the sound algebraic identities throughout a module. Pure (module -> module).
 *  Raw-Stmt fns are skipped (#763 P1) — identity rewrites must not touch authored
 *  arithmetic around a verbatim raw splice. */
export function algebraicSimplify(m: ModuleDecl): ModuleDecl {
  return mapModuleExprs(m, simplifyNode, { skipRawBodies: true })
}
