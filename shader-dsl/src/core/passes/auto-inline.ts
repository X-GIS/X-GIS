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

import { stageOf } from '../ir'
import type { Expr, ModuleDecl, FuncDecl } from '../ir'
import { mapStmt } from './opt/ir-transform'
import { bodyHasRaw } from './opt/dce'
import { inlineFn } from './inline'

// Shared stage predicate (#763 S4 — this site was MISSED in the Phase-S sweep:
// it lives under passes/, not passes/opt/, and the sweep grepped opt/ only).
const isEntry = (f: FuncDecl): boolean => stageOf(f) !== undefined

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
    case 'logical':
      return 1 + exprCost(e.a) + exprCost(e.b)
    case 'unop':
      return 1 + exprCost(e.a)
    case 'call':
    case 'construct':
      return 1 + e.args.reduce((n, a) => n + exprCost(a), 0)
    case 'member':
      return 1 + exprCost(e.base)
    case 'index':
      return 1 + exprCost(e.base) + exprCost(e.idx)
    case 'select':
      return 1 + exprCost(e.cond) + exprCost(e.ifTrue) + exprCost(e.ifFalse)
    case 'matchExpr':
      return (
        1 +
        exprCost(e.scrutinee) +
        e.cases.reduce((n, [, v]) => n + exprCost(v), 0) +
        exprCost(e.default)
      )
    default:
      return 1 // lit / constref / param / varref
  }
}

/** Count `call` sites of `name` across every fn body in the module. */
function countCalls(m: ModuleDecl, name: string): number {
  let n = 0
  const probe = (e: Expr): Expr => {
    if (e.op === 'call' && e.fn === name) n++
    return e
  }
  for (const f of m.funcs) for (const s of f.body) mapStmt(s, probe)
  return n
}

/** The single-return expression of a helper that is SAFE to inline — non-entry,
 *  non-df64, non-recursive, and still called — or undefined if `f` fails any of
 *  those. The shared filter behind both the size heuristic (autoInline) and the
 *  obfuscation "inline everything" pass (inlineAll).
 *
 *  df64_* emulation helpers are PERMANENTLY opaque (never inlined): their bodies
 *  are error-free transformations the algebraic/const-fold passes could legally
 *  cancel once exposed at a call site — see core/fp64/df64-lib.ts. Recursive
 *  single-return fns are skipped (inlineFn keeps them; infinite expansion
 *  otherwise). A dead fn (0 calls) is left to deadFnElim, not inlining. */
function inlinableRet(m: ModuleDecl, f: FuncDecl): Expr | undefined {
  if (isEntry(f) || f.name.startsWith('df64_')) return undefined
  const ret = singleReturnExpr(f)
  if (ret === undefined) return undefined
  let recursive = false
  mapStmt({ s: 'return', expr: ret }, (e) => {
    if (e.op === 'call' && e.fn === f.name) recursive = true
    return e
  })
  if (recursive) return undefined
  return countCalls(m, f.name) > 0 ? ret : undefined
}

/** Pick the next helper to inline by the SIZE heuristic (single-call or
 *  leaf-return), or undefined when none qualifies. */
function pickCandidate(m: ModuleDecl): string | undefined {
  for (const f of m.funcs) {
    const ret = inlinableRet(m, f)
    if (ret === undefined) continue
    if (countCalls(m, f.name) === 1 || exprCost(ret) === 1) return f.name
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
