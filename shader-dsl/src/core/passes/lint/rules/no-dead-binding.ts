import type { Stmt, Expr } from '../../../ir'
import type { LintRule } from '../engine'

// Walk every sub-expression of `e`, invoking `onExpr` on each (incl. `e` itself).
function eachExpr(e: Expr, onExpr: (e: Expr) => void): void {
  onExpr(e)
  switch (e.op) {
    case 'binop':
    case 'compare':
    case 'logical':
      eachExpr(e.a, onExpr)
      eachExpr(e.b, onExpr)
      break
    case 'unop':
      eachExpr(e.a, onExpr)
      break
    case 'call':
    case 'construct':
      for (const a of e.args) eachExpr(a, onExpr)
      break
    case 'member':
      eachExpr(e.base, onExpr)
      break
    case 'index':
      eachExpr(e.base, onExpr)
      eachExpr(e.idx, onExpr)
      break
    case 'select':
      eachExpr(e.cond, onExpr)
      eachExpr(e.ifTrue, onExpr)
      eachExpr(e.ifFalse, onExpr)
      break
    case 'matchExpr':
      eachExpr(e.scrutinee, onExpr)
      for (const [, v] of e.cases) eachExpr(v, onExpr)
      eachExpr(e.default, onExpr)
      break
    default:
      break // lit / constref / param / varref — leaves
  }
}

// Walk every statement (recursively into blocks), invoking `onStmt` on each and
// `onExpr` on each Expr it contains. Mirrors the engine's traversal shape.
function eachStmt(s: Stmt, onStmt: (s: Stmt) => void, onExpr: (e: Expr) => void): void {
  onStmt(s)
  switch (s.s) {
    case 'let':
      eachExpr(s.expr, onExpr)
      break
    case 'var':
      if (s.init) eachExpr(s.init, onExpr)
      break
    case 'assign':
    case 'assignOp':
      eachExpr(s.target, onExpr)
      eachExpr(s.expr, onExpr)
      break
    case 'return':
      if (s.expr) eachExpr(s.expr, onExpr)
      break
    case 'if':
      for (const arm of s.arms) {
        eachExpr(arm.cond, onExpr)
        for (const b of arm.body) eachStmt(b, onStmt, onExpr)
      }
      if (s.elseBody) for (const b of s.elseBody) eachStmt(b, onStmt, onExpr)
      break
    case 'for':
      eachStmt(s.init, onStmt, onExpr)
      eachExpr(s.cond, onExpr)
      eachStmt(s.update, onStmt, onExpr)
      for (const b of s.body) eachStmt(b, onStmt, onExpr)
      break
    case 'switch':
      eachExpr(s.scrut, onExpr)
      for (const c of s.cases) for (const b of c.body) eachStmt(b, onStmt, onExpr)
      if (s.defaultBody) for (const b of s.defaultBody) eachStmt(b, onStmt, onExpr)
      break
    default:
      break // break / continue / discard / raw / placeholder — leaves
  }
}

/** No dead `let` binding: flag a `let` whose name is never referenced (no `varref`
 *  with that name) anywhere in the fn body. A Func handler collects the `let` names
 *  and the set of referenced varref names in one walk, then reports the difference. */
export const noDeadBinding: LintRule = {
  id: 'no-dead-binding',
  description: 'no dead `let` binding — a `let` whose name is never referenced is wasted work',
  severity: 'warning',
  category: 'correctness',
  create: (ctx) => ({
    Func(f) {
      const letNames: string[] = []
      const referenced = new Set<string>()
      for (const s of f.body) {
        eachStmt(
          s,
          (st) => {
            if (st.s === 'let') letNames.push(st.name)
          },
          (e) => {
            if (e.op === 'varref') referenced.add(e.name)
          },
        )
      }
      for (const name of letNames) {
        if (!referenced.has(name)) {
          ctx.report(`dead binding '${name}' in fn '${f.name}' — never referenced`, { fn: f.name })
        }
      }
    },
  }),
}
