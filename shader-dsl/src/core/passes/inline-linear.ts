// ═══ Shader DSL — linear (multi-statement) function inlining ═══
//
// Extends `inlineFn` (single-return-EXPRESSION only) to LINEAR SINGLE-EXIT
// helpers: a body that is zero-or-more `let`/`var`/`assign`/`assignOp`
// statements followed by exactly one trailing `return e` — no `if`/`for`/
// `switch`/early-return/`raw`. `noise() { let i = …; let f = …; return mix(…) }`
// is the shape. Inlining such a body into an expression position is done by
// LIFTING: the helper's prelude statements (with its locals freshly renamed and
// its params bound to temps) are spliced into the caller's block immediately
// before the statement that contains the call, and the call is replaced by a
// varref to a temp holding the (substituted) return expression.
//
// WHY IT'S VALUE-SAFE. Shader code is pure — no I/O, no observable evaluation
// order. So hoisting a pure sub-expression's computation earlier in the same
// block (or ahead of an `if`/`switch` it fed) cannot change any result; at most
// it computes a value a branch won't use, which is unobservable. That is the
// whole license for this transform, and it's why the CONSERVATIVE exclusions
// below are the only ones needed. It is the obfuscation counterpart of a JS
// minifier's function inlining (`@xgis/shader-dsl/emit-prod`'s `inline()`).
//
// CONSERVATIVE EXCLUSIONS (leave the function; never inline unsoundly):
//   • body isn't linear-single-exit (control flow / early return) — can't be an
//     expression value;
//   • a call site sits in a `for` init/cond/update — lifting it out would change
//     how many times it runs;
//   • df64_* (opacity invariant), entry points, recursive fns — as in autoInline.
// Everything else — calls in let/var/assign/return exprs, `if` conditions,
// `switch` scrutinees, and inside any block body — is lifted within its own
// block, so conditional execution is preserved.

import { stageOf } from '../ir'
import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../ir'
import { mapExpr } from './opt/ir-transform'
import { bodyHasRaw } from './opt/dce'
import { inlineFn } from './inline'

const isEntry = (f: FuncDecl): boolean => stageOf(f) !== undefined

/** A linear single-exit body split into its prelude (all non-return stmts) and
 *  its single trailing return expression — or undefined if `f` isn't that shape. */
function linearBody(f: FuncDecl): { prelude: readonly Stmt[]; ret: Expr } | undefined {
  const body = f.body
  if (body.length === 0) return undefined
  const last = body[body.length - 1]!
  if (last.s !== 'return' || last.expr === undefined) return undefined
  const prelude = body.slice(0, -1)
  for (const s of prelude)
    if (s.s !== 'let' && s.s !== 'var' && s.s !== 'assign' && s.s !== 'assignOp') return undefined
  return { prelude, ret: last.expr }
}

/** Does any expression in `e` call `name`? */
function exprCallsName(e: Expr, name: string): boolean {
  let found = false
  mapExpr(e, (x) => {
    if (x.op === 'call' && x.fn === name) found = true
    return x
  })
  return found
}

/** Does statement `s` (its OWN exprs, not nested block bodies) call `name`? */
function stmtOwnExprCallsName(s: Stmt, name: string): boolean {
  switch (s.s) {
    case 'let':
      return exprCallsName(s.expr, name)
    case 'var':
      return s.init !== undefined && exprCallsName(s.init, name)
    case 'assign':
    case 'assignOp':
      return exprCallsName(s.target, name) || exprCallsName(s.expr, name)
    case 'return':
      return s.expr !== undefined && exprCallsName(s.expr, name)
    default:
      return false
  }
}

/** True if `name` is called anywhere in a `for` init/cond/update across the
 *  module — the one call-site position that isn't safely liftable. */
function calledInForHeader(m: ModuleDecl, name: string): boolean {
  let found = false
  const walk = (stmts: readonly Stmt[]): void => {
    for (const s of stmts) {
      if (s.s === 'for') {
        if (
          stmtOwnExprCallsName(s.init, name) ||
          exprCallsName(s.cond, name) ||
          stmtOwnExprCallsName(s.update, name)
        )
          found = true
        walk(s.body)
      } else if (s.s === 'if') {
        for (const a of s.arms) walk(a.body)
        if (s.elseBody) walk(s.elseBody)
      } else if (s.s === 'switch') {
        for (const c of s.cases) walk(c.body)
        if (s.defaultBody) walk(s.defaultBody)
      }
    }
  }
  for (const f of m.funcs) walk(f.body)
  return found
}

/** True if the whole module still contains a call to `name`. */
function moduleCallsName(m: ModuleDecl, name: string): boolean {
  return m.funcs.some((f) => f.body.some((s) => stmtDeepCallsName(s, name)))
}
function stmtDeepCallsName(s: Stmt, name: string): boolean {
  if (stmtOwnExprCallsName(s, name)) return true
  switch (s.s) {
    case 'if':
      return (
        s.arms.some((a) => exprCallsName(a.cond, name) || a.body.some((b) => stmtDeepCallsName(b, name))) ||
        (s.elseBody?.some((b) => stmtDeepCallsName(b, name)) ?? false)
      )
    case 'for':
      return (
        stmtOwnExprCallsName(s.init, name) ||
        exprCallsName(s.cond, name) ||
        stmtOwnExprCallsName(s.update, name) ||
        s.body.some((b) => stmtDeepCallsName(b, name))
      )
    case 'switch':
      return (
        exprCallsName(s.scrut, name) ||
        s.cases.some((c) => c.body.some((b) => stmtDeepCallsName(b, name))) ||
        (s.defaultBody?.some((b) => stmtDeepCallsName(b, name)) ?? false)
      )
    default:
      return false
  }
}

/** Recursive: is `f` (single-return OR linear) a non-entry, non-df64,
 *  non-recursive, still-called helper safe to inline in every call position?
 *  `requireMultiStatement` gates the two passes so single-return goes through
 *  the simpler inlineFn first. */
function isInlinable(
  m: ModuleDecl,
  f: FuncDecl,
  requireMultiStatement: boolean,
): boolean {
  if (isEntry(f) || f.name.startsWith('df64_')) return false
  const lb = linearBody(f)
  if (lb === undefined) return false
  if (requireMultiStatement !== lb.prelude.length > 0) return false
  if (exprCallsName(lb.ret, f.name) || lb.prelude.some((s) => stmtOwnExprCallsName(s, f.name)))
    return false // recursive
  if (!moduleCallsName(m, f.name)) return false // dead — leave to deadFnElim
  // multi-statement lifting is unsound only for for-header call sites.
  if (requireMultiStatement && calledInForHeader(m, f.name)) return false
  return true
}

/** Inline a linear single-exit helper at every (liftable) call site, splicing
 *  its prelude into each caller's block. `counter` is a run-global uniquifier so
 *  spliced local names never collide across inline instances (and the result is
 *  deterministic — required for the two GLSL stage emits to agree). */
export function inlineLinearFn(m: ModuleDecl, name: string, counter: { n: number }): ModuleDecl {
  const target = m.funcs.find((f) => f.name === name)
  const lb = target && linearBody(target)
  if (!target || !lb) return m

  // Params actually referenced by the body — only those get an arg temp.
  const usedParams = new Set<string>()
  const probeParam = (e: Expr): void => {
    mapExpr(e, (x) => {
      if ((x.op === 'param' || x.op === 'varref') && target.params.some((p) => p.name === x.name))
        usedParams.add(x.name)
      return x
    })
  }
  for (const s of lb.prelude) forEachStmtExpr(s, probeParam)
  probeParam(lb.ret)

  /** Replace every call to `name` in `e` with a fresh temp varref, pushing the
   *  inlined prelude + temp bindings into `lifted` (bottom-up: nested calls
   *  land first, preserving order). */
  const liftCalls = (e: Expr, lifted: Stmt[]): Expr =>
    mapExpr(e, (x) => {
      if (x.op !== 'call' || x.fn !== name) return x
      const p = `_inl${counter.n++}_`
      const subst = new Map<string, Expr>()
      target.params.forEach((param, i) => {
        if (!usedParams.has(param.name)) return
        const argTmp = `${p}a${i}`
        lifted.push({ s: 'let', name: argTmp, expr: x.args[i]! })
        subst.set(param.name, { op: 'varref', type: param.type, name: argTmp })
      })
      const localRen = new Map<string, string>()
      // `p` ends in `_` and optimizer locals start with `_` (`_cse0`, `_v0`) —
      // concatenating would form `__`, which GLSL ES reserves. Drop the local's
      // one leading underscore so the join stays a single separator.
      for (const st of lb.prelude)
        if (st.s === 'let' || st.s === 'var')
          localRen.set(st.name, `${p}${st.name.replace(/^_/, '')}`)
      const rw = (ex: Expr): Expr =>
        mapExpr(ex, (y) => {
          if (y.op === 'param' || y.op === 'varref') {
            if (subst.has(y.name)) return subst.get(y.name)!
            if (localRen.has(y.name)) return { ...y, name: localRen.get(y.name)! }
          }
          return y
        })
      for (const st of lb.prelude) lifted.push(renameStmt(st, localRen, rw))
      const retTmp = `${p}ret`
      lifted.push({ s: 'let', name: retTmp, expr: rw(lb.ret) })
      return { op: 'varref', type: target.ret, name: retTmp }
    })

  const inlineInBlock = (stmts: readonly Stmt[]): Stmt[] => {
    const out: Stmt[] = []
    for (const s of stmts) {
      const lifted: Stmt[] = []
      const L = (e: Expr): Expr => liftCalls(e, lifted)
      let s2: Stmt
      switch (s.s) {
        case 'let':
          s2 = { ...s, expr: L(s.expr) }
          break
        case 'var':
          s2 = s.init !== undefined ? { ...s, init: L(s.init) } : s
          break
        case 'assign':
        case 'assignOp':
          s2 = { ...s, target: L(s.target), expr: L(s.expr) }
          break
        case 'return':
          s2 = s.expr !== undefined ? { ...s, expr: L(s.expr) } : s
          break
        case 'if':
          s2 = {
            ...s,
            arms: s.arms.map((a) => ({ cond: L(a.cond), body: inlineInBlock(a.body) })),
            elseBody: s.elseBody ? inlineInBlock(s.elseBody) : undefined,
          }
          break
        case 'for':
          // header never calls `name` (calledInForHeader gate); only the body can.
          s2 = { ...s, body: inlineInBlock(s.body) }
          break
        case 'switch':
          s2 = {
            ...s,
            scrut: L(s.scrut),
            cases: s.cases.map((c) => ({ ...c, body: inlineInBlock(c.body) })),
            defaultBody: s.defaultBody ? inlineInBlock(s.defaultBody) : undefined,
          }
          break
        default:
          s2 = s
      }
      out.push(...lifted, s2)
    }
    return out
  }

  const others = m.funcs
    .filter((f) => f !== target)
    .map((f): FuncDecl => ({ ...f, body: inlineInBlock(f.body) }))
  const stillCalled = others.some((f) => f.body.some((s) => stmtDeepCallsName(s, name)))
  return { ...m, funcs: stillCalled ? [target, ...others] : others }
}

/** Apply an expr rewrite to a statement's OWN expressions (not nested blocks). */
function forEachStmtExpr(s: Stmt, visit: (e: Expr) => void): void {
  switch (s.s) {
    case 'let':
      visit(s.expr)
      break
    case 'var':
      if (s.init !== undefined) visit(s.init)
      break
    case 'assign':
    case 'assignOp':
      visit(s.target)
      visit(s.expr)
      break
    case 'return':
      if (s.expr !== undefined) visit(s.expr)
      break
    default:
      break
  }
}

/** Rename a prelude statement's declared name (let/var) and rewrite its exprs. */
function renameStmt(s: Stmt, localRen: ReadonlyMap<string, string>, rw: (e: Expr) => Expr): Stmt {
  switch (s.s) {
    case 'let':
      return { s: 'let', name: localRen.get(s.name) ?? s.name, expr: rw(s.expr) }
    case 'var':
      return {
        s: 'var',
        name: localRen.get(s.name) ?? s.name,
        type: s.type,
        ...(s.init !== undefined ? { init: rw(s.init) } : {}),
      }
    case 'assign':
      return { ...s, target: rw(s.target), expr: rw(s.expr) }
    case 'assignOp':
      return { ...s, target: rw(s.target), expr: rw(s.expr) }
    default:
      return s
  }
}

/** Inline EVERY safely-inlinable helper — single-return via the proven inlineFn,
 *  then linear multi-statement via inlineLinearFn — until none remain. Pure
 *  (module -> module); `@xgis/shader-dsl/emit-prod`'s inline() plugin. */
export function inlineLinearAll(m: ModuleDecl): ModuleDecl {
  if (m.funcs.some((f) => bodyHasRaw(f.body))) return m
  let cur = m
  const counter = { n: 0 }
  // Each step removes exactly one helper, so the fn count bounds the loop.
  for (let i = 0; i <= m.funcs.length; i++) {
    const single = cur.funcs.find((f) => isInlinable(cur, f, false))
    if (single) {
      cur = inlineFn(cur, single.name)
      continue
    }
    const linear = cur.funcs.find((f) => isInlinable(cur, f, true))
    if (linear) {
      cur = inlineLinearFn(cur, linear.name, counter)
      continue
    }
    break
  }
  return cur
}
