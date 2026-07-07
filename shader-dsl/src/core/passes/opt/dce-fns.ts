// ═══ Shader DSL — dead-FUNCTION elimination (tree-shaking) pass ═══
//
// Drops module functions that are UNREACHABLE from the entry points. The
// local `dce` pass prunes dead bindings INSIDE a fn; this prunes whole fns no
// entry point can ever call (e.g. a helper left behind after dead-branch elim
// removed its only call site, or an over-broad shared prelude). Pure + safe:
// an uncallable function has no observable effect, so removing it is bit-exact
// (the oracle / GPU values are unchanged; only the emitted bytes shrink).
//
// Reachability:
//   • Roots = entry points — a fn with a non-empty `attrs` (`@vertex` /
//     `@fragment` / `@compute …`). Helpers have empty attrs.
//   • Edge = a `call` Expr whose `fn` names another MODULE function (builtins
//     like `i32` / `vec4` / `max` have no matching FuncDecl, so they're ignored).
//   • Keep every fn reachable from a root (transitively); drop the rest.
//
// Conservative bail-outs (match the local dce's leniency — never drop a fn that
// MIGHT be referenced by something the IR walker can't see):
//   • Any `raw` Stmt anywhere → a raw WGSL fragment can call a helper by name
//     textually, invisible to this walk → skip whole-module tree-shaking.
//   • No entry points → can't compute reachability (a helper-only func list,
//     e.g. the `emitFuncsCsed` parity-harness path) → no-op, keep everything.

import { stageOf } from '../../ir'
import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir'
import { bodyHasRaw } from './dce'

function collectExprCalls(e: Expr, out: Set<string>): void {
  switch (e.op) {
    case 'call':
      out.add(e.fn)
      for (const a of e.args) collectExprCalls(a, out)
      break
    case 'construct':
      for (const a of e.args) collectExprCalls(a, out)
      break
    case 'binop':
    case 'compare':
    case 'logical':
      collectExprCalls(e.a, out)
      collectExprCalls(e.b, out)
      break
    case 'unop':
      collectExprCalls(e.a, out)
      break
    case 'member':
      collectExprCalls(e.base, out)
      break
    case 'index':
      collectExprCalls(e.base, out)
      collectExprCalls(e.idx, out)
      break
    case 'select':
      collectExprCalls(e.cond, out)
      collectExprCalls(e.ifTrue, out)
      collectExprCalls(e.ifFalse, out)
      break
    case 'matchExpr':
      collectExprCalls(e.scrutinee, out)
      for (const [, v] of e.cases) collectExprCalls(v, out)
      collectExprCalls(e.default, out)
      break
    default:
      break // lit / constref / param / varref — no nested calls
  }
}

function collectStmtCalls(s: Stmt, out: Set<string>): void {
  switch (s.s) {
    case 'let':
      collectExprCalls(s.expr, out)
      break
    case 'var':
      if (s.init !== undefined) collectExprCalls(s.init, out)
      break
    case 'assign':
    case 'assignOp':
      collectExprCalls(s.target, out)
      collectExprCalls(s.expr, out)
      break
    case 'return':
      if (s.expr !== undefined) collectExprCalls(s.expr, out)
      break
    case 'if':
      for (const arm of s.arms) {
        collectExprCalls(arm.cond, out)
        for (const b of arm.body) collectStmtCalls(b, out)
      }
      if (s.elseBody) for (const b of s.elseBody) collectStmtCalls(b, out)
      break
    case 'for':
      collectStmtCalls(s.init, out)
      collectExprCalls(s.cond, out)
      collectStmtCalls(s.update, out)
      for (const b of s.body) collectStmtCalls(b, out)
      break
    case 'switch':
      collectExprCalls(s.scrut, out)
      for (const c of s.cases) for (const b of c.body) collectStmtCalls(b, out)
      if (s.defaultBody) for (const b of s.defaultBody) collectStmtCalls(b, out)
      break
    default:
      break // break / continue / discard / placeholder / raw — no Expr to walk
  }
}

// Roots = pipeline entries via the shared stage predicate (#763 S4) — the old
// `attrs.length > 0` missed structured-only entries and mistook any attr'd
// helper for a root.
const isEntry = (f: FuncDecl): boolean => stageOf(f) !== undefined

/** Remove functions unreachable from the module's entry points. Pure (module -> module). */
export function deadFnElim(m: ModuleDecl): ModuleDecl {
  // A raw WGSL stmt may textually call a helper this walk can't see → bail.
  if (m.funcs.some((f) => bodyHasRaw(f.body))) return m

  const roots = m.funcs.filter(isEntry)
  // Helper-only func list (no entry point) → reachability is undefined; keep all.
  if (roots.length === 0) return m

  const byName = new Map(m.funcs.map((f) => [f.name, f]))
  const reachable = new Set<string>(roots.map((f) => f.name))
  const stack: FuncDecl[] = [...roots]
  while (stack.length > 0) {
    const f = stack.pop()!
    const calls = new Set<string>()
    for (const s of f.body) collectStmtCalls(s, calls)
    for (const name of calls) {
      if (byName.has(name) && !reachable.has(name)) {
        reachable.add(name)
        stack.push(byName.get(name)!)
      }
    }
  }

  if (reachable.size === m.funcs.length) return m // nothing unreachable
  return { ...m, funcs: m.funcs.filter((f) => reachable.has(f.name)) }
}
