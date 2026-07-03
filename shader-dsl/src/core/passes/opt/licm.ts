// ═══ Shader DSL — loop-invariant code motion (Optimization context) ═══
//
// A compound expression computed inside a loop body that depends ONLY on fn
// inputs (params / consts / bindings — no local, so it cannot change across
// iterations) is recomputed every iteration for nothing. Hoist it to a single
// `let` at the fn top (input-only ⇒ valid there) and replace each occurrence.
//
// MAXIMAL: gathers the largest input-only subexpression (if the whole expr is
// invariant, hoist it whole rather than its parts) — so hoisted exprs never nest.
// A fn containing a raw Stmt is skipped (raw WGSL is opaque). Correctness is
// pinned by oracle value-equality.

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir'
import {
  keyOf,
  isCompound,
  refsLocal,
  mapChildren,
  mapStmtTop,
  bodyHasRaw,
  collectLocals,
  collectMutatedRoots,
} from './expr-utils'

/** Collect the MAXIMAL input-only compound subexpressions of `e` into `out`. */
function gatherExpr(e: Expr, locals: ReadonlySet<string>, out: Map<string, Expr>): void {
  if (isCompound(e) && !refsLocal(e, locals)) {
    out.set(keyOf(e), e)
    return
  }
  switch (e.op) {
    case 'binop':
    case 'compare':
    case 'logical':
      gatherExpr(e.a, locals, out)
      gatherExpr(e.b, locals, out)
      break
    case 'unop':
      gatherExpr(e.a, locals, out)
      break
    case 'call':
    case 'construct':
      for (const a of e.args) gatherExpr(a, locals, out)
      break
    case 'member':
      gatherExpr(e.base, locals, out)
      break
    case 'index':
      gatherExpr(e.base, locals, out)
      gatherExpr(e.idx, locals, out)
      break
    case 'select':
      gatherExpr(e.cond, locals, out)
      gatherExpr(e.ifTrue, locals, out)
      gatherExpr(e.ifFalse, locals, out)
      break
    case 'matchExpr':
      gatherExpr(e.scrutinee, locals, out)
      for (const [, v] of e.cases) gatherExpr(v, locals, out)
      gatherExpr(e.default, locals, out)
      break
    default:
      break // lit / constref / param / varref
  }
}

/** Walk stmts gathering invariants only from exprs that execute inside a loop. */
function gatherStmt(
  s: Stmt,
  inLoop: boolean,
  locals: ReadonlySet<string>,
  out: Map<string, Expr>,
): void {
  const ge = (e: Expr): void => {
    if (inLoop) gatherExpr(e, locals, out)
  }
  switch (s.s) {
    case 'let':
      ge(s.expr)
      break
    case 'var':
      if (s.init !== undefined) ge(s.init)
      break
    case 'assign':
    case 'assignOp':
      ge(s.target)
      ge(s.expr)
      break
    case 'return':
      if (s.expr !== undefined) ge(s.expr)
      break
    case 'if':
      for (const a of s.arms) {
        ge(a.cond)
        for (const b of a.body) gatherStmt(b, inLoop, locals, out)
      }
      if (s.elseBody) for (const b of s.elseBody) gatherStmt(b, inLoop, locals, out)
      break
    case 'for':
      gatherExpr(s.cond, locals, out) // the loop cond runs every iteration
      gatherStmt(s.init, inLoop, locals, out) // init runs once
      gatherStmt(s.update, true, locals, out)
      for (const b of s.body) gatherStmt(b, true, locals, out)
      break
    case 'switch':
      ge(s.scrut)
      for (const c of s.cases) for (const b of c.body) gatherStmt(b, inLoop, locals, out)
      if (s.defaultBody) for (const b of s.defaultBody) gatherStmt(b, inLoop, locals, out)
      break
    default:
      break
  }
}

function licmFn(f: FuncDecl): FuncDecl {
  if (bodyHasRaw(f.body)) return f
  // Non-invariant names: function locals AND any mutated name (incl. a read_write
  // binding written anywhere in the fn). A read of a mutated name is not loop-invariant.
  const noHoist = new Set<string>()
  collectLocals(f.body, noHoist)
  collectMutatedRoots(f.body, noHoist)

  const invariants = new Map<string, Expr>()
  for (const s of f.body) gatherStmt(s, false, noHoist, invariants)
  if (invariants.size === 0) return f

  const temp = new Map<string, string>()
  const lets: Stmt[] = []
  // Seed past any existing `_licmN` (#763 P2) — the fixpoint re-runs passes, and
  // a const/copy-prop round can expose a NEW hoistable compound after a first
  // hoist already emitted `_licm0`; a reset counter would redeclare it (backend
  // compile error — nothing re-validates post-optimize). Same seeding as cse/gvn.
  let n = 0
  for (const existing of noHoist) {
    const mm = /^_licm(\d+)$/.exec(existing)
    if (mm) n = Math.max(n, Number(mm[1]) + 1)
  }
  for (const [k, e] of invariants) {
    const name = `_licm${n++}`
    temp.set(k, name)
    lets.push({ s: 'let', name, expr: e })
  }

  const replace = (e: Expr): Expr => {
    const t = temp.get(keyOf(e))
    if (t !== undefined) return { op: 'varref', type: e.type, name: t }
    return mapChildren(e, replace)
  }
  const newBody = f.body.map((s) => mapStmtTop(s, replace))
  return { ...f, body: [...lets, ...newBody] }
}

/** Hoist loop-invariant input-only subexpressions. Pure (module -> module). */
export function licm(m: ModuleDecl): ModuleDecl {
  return { ...m, funcs: m.funcs.map(licmFn) }
}
