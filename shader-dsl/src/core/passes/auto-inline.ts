// ═══ Shader DSL — automatic function inlining (Composition context) ═══
//
// autoInline(module) is the cost-driven AUTO wrapper over `inlineFn`: it picks
// WHICH single-return helpers to inline by a size/call-count heuristic and
// applies inlineFn to each, instead of the caller naming one fn. Addresses the
// "wire inline as an auto pass — needs a SIZE/cost heuristic (inline small /
// single-call only; blind inlining bloats, e.g. terrain() inlined 10x)" item
// of #627. Pure (module -> module); inherits inlineFn's oracle value-equality.
//
// Heuristic — inline a non-entry, non-recursive, single-return helper iff:
//   • it is called EXACTLY ONCE (single-call: removing the decl + the one call
//     site is a strict size win, never duplicates work), OR
//   • its return expression is a LEAF (cost 1: a bare param / literal / const /
//     varref — an alias or constant wrapper). A leaf never grows a call site
//     when substituted (an identity `return x` just drops the indirection; a
//     constant `return K` shrinks each site), so it is safe at any call count.
// Everything else is left alone — that is the "blind inlining bloats" guard.
//
// Like `inlineFn` and `deadFnElim`, this is an available-but-unwired pass: it is
// NOT in DEFAULT_PASSES (wiring it changes production WGSL bytes -> the byte-stable
// shared-prelude golden snapshots would need regenerating, a maintainer decision).

import type { Expr, ModuleDecl, FuncDecl } from '../ir'
import { mapStmt } from './opt/ir-transform'
import { bodyHasRaw } from './opt/dce'
import { inlineFn } from './inline'

const isEntry = (f: FuncDecl): boolean => (f.attrs?.length ?? 0) > 0

/** The single-return expression of `f`, or undefined if `f` isn't `{ return e }`. */
function singleReturnExpr(f: FuncDecl): Expr | undefined {
  const only = f.body.length === 1 ? f.body[0] : undefined
  return only && only.s === 'return' && only.expr !== undefined ? only.expr : undefined
}

/** Node-count cost of an expression — a leaf (param / lit / const / varref) is 1. */
function exprCost(e: Expr): number {
  switch (e.op) {
    case 'binop':
    case 'compare':
    case 'logical': return 1 + exprCost(e.a) + exprCost(e.b)
    case 'unop': return 1 + exprCost(e.a)
    case 'call':
    case 'construct': return 1 + e.args.reduce((n, a) => n + exprCost(a), 0)
    case 'member': return 1 + exprCost(e.base)
    case 'index': return 1 + exprCost(e.base) + exprCost(e.idx)
    case 'select': return 1 + exprCost(e.cond) + exprCost(e.ifTrue) + exprCost(e.ifFalse)
    case 'matchExpr':
      return 1 + exprCost(e.scrutinee) + e.cases.reduce((n, [, v]) => n + exprCost(v), 0) + exprCost(e.default)
    default: return 1 // lit / constref / param / varref
  }
}

/** Count `call` sites of `name` across every fn body in the module. */
function countCalls(m: ModuleDecl, name: string): number {
  let n = 0
  const probe = (e: Expr): Expr => { if (e.op === 'call' && e.fn === name) n++; return e }
  for (const f of m.funcs) for (const s of f.body) mapStmt(s, probe)
  return n
}

/** Pick the next helper to inline by the heuristic, or undefined when none qualifies. */
function pickCandidate(m: ModuleDecl): string | undefined {
  for (const f of m.funcs) {
    if (isEntry(f)) continue
    const ret = singleReturnExpr(f)
    if (ret === undefined) continue
    // Recursive single-return fn — inlineFn keeps it (infinite expansion otherwise); skip.
    let recursive = false
    mapStmt({ s: 'return', expr: ret }, (e) => { if (e.op === 'call' && e.fn === f.name) recursive = true; return e })
    if (recursive) continue
    const calls = countCalls(m, f.name)
    if (calls === 0) continue // dead — leave to deadFnElim, not inlining
    if (calls === 1 || exprCost(ret) === 1) return f.name
  }
  return undefined
}

/** Auto-inline small / single-call helpers throughout a module. Pure (module -> module). */
export function autoInline(m: ModuleDecl): ModuleDecl {
  // A raw WGSL stmt may call a helper textually (invisible to the IR walk) — bail.
  if (m.funcs.some((f) => bodyHasRaw(f.body))) return m
  let cur = m
  // Each inlineFn removes its target, so the candidate set strictly shrinks;
  // the fn-count bound is a belt-and-suspenders cap on the loop.
  for (let i = 0; i < m.funcs.length; i++) {
    const name = pickCandidate(cur)
    if (name === undefined) break
    cur = inlineFn(cur, name)
  }
  return cur
}
