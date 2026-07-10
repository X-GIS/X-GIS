// ═══ Shader DSL — shared IR analysis utilities (Optimization context) ═══
//
// The structural-key / traversal / scope helpers shared by the analysis passes
// (CSE, LICM, …). Kept in one place so the two passes cannot drift (duplicated
// traversal logic that must agree is this codebase's #1 bug archetype).

import type { Expr, Stmt } from '../../ir'
import { typeKey } from '../../ir'

/** A deterministic structural key — two structurally-equal exprs share a key. */
export function keyOf(e: Expr): string {
  switch (e.op) {
    case 'lit':
      return `L:${typeof e.value}:${String(e.value)}`
    case 'constref':
      return `C:${e.name}`
    case 'overrideref':
      return `O:${e.name}` // #923 — distinct from a const read (never CSE'd together)
    case 'param':
      return `P:${e.name}`
    case 'varref':
      return `V:${e.name}`
    case 'binop':
      return `(${keyOf(e.a)}${e.bop}${keyOf(e.b)})`
    case 'compare':
      return `(${keyOf(e.a)}${e.cop}${keyOf(e.b)})`
    case 'logical':
      return `(${keyOf(e.a)}${e.lop}${keyOf(e.b)})`
    case 'unop':
      return `(-${keyOf(e.a)})`
    case 'call':
      return `${e.fn}(${e.args.map(keyOf).join(',')})`
    case 'construct':
      return `${typeKey(e.type)}{${e.args.map(keyOf).join(',')}}`
    case 'member':
      return `${keyOf(e.base)}.${e.field}`
    case 'index':
      return `${keyOf(e.base)}[${keyOf(e.idx)}]`
    case 'select':
      return `S(${keyOf(e.cond)},${keyOf(e.ifTrue)},${keyOf(e.ifFalse)})`
    case 'matchExpr':
      return `M(${keyOf(e.scrutinee)};${e.cases.map(([n, v]) => `${n}:${keyOf(v)}`).join(',')};${keyOf(e.default)})`
  }
}

/** Compound = a non-leaf expr (worth hoisting / counting). */
export const isCompound = (e: Expr): boolean =>
  e.op !== 'lit' &&
  e.op !== 'constref' &&
  e.op !== 'overrideref' &&
  e.op !== 'param' &&
  e.op !== 'varref'

/** Visit `e` and every descendant (pre-order). */
export function eachExpr(e: Expr, visit: (e: Expr) => void): void {
  visit(e)
  switch (e.op) {
    case 'binop':
    case 'compare':
    case 'logical':
      eachExpr(e.a, visit)
      eachExpr(e.b, visit)
      break
    case 'unop':
      eachExpr(e.a, visit)
      break
    case 'call':
    case 'construct':
      for (const a of e.args) eachExpr(a, visit)
      break
    case 'member':
      eachExpr(e.base, visit)
      break
    case 'index':
      eachExpr(e.base, visit)
      eachExpr(e.idx, visit)
      break
    case 'select':
      eachExpr(e.cond, visit)
      eachExpr(e.ifTrue, visit)
      eachExpr(e.ifFalse, visit)
      break
    case 'matchExpr':
      eachExpr(e.scrutinee, visit)
      for (const [, v] of e.cases) eachExpr(v, visit)
      eachExpr(e.default, visit)
      break
    default:
      break
  }
}

/** Rebuild `e` with `f` applied to its direct children only (self untouched). */
export function mapChildren(e: Expr, f: (c: Expr) => Expr): Expr {
  switch (e.op) {
    case 'lit':
    case 'constref':
    case 'overrideref':
    case 'param':
    case 'varref':
      return e
    case 'binop':
      return { ...e, a: f(e.a), b: f(e.b) }
    case 'compare':
      return { ...e, a: f(e.a), b: f(e.b) }
    case 'logical':
      return { ...e, a: f(e.a), b: f(e.b) }
    case 'unop':
      return { ...e, a: f(e.a) }
    case 'call':
      return { ...e, args: e.args.map(f) }
    case 'construct':
      return { ...e, args: e.args.map(f) }
    case 'member':
      return { ...e, base: f(e.base) }
    case 'index':
      return { ...e, base: f(e.base), idx: f(e.idx) }
    case 'select':
      return { ...e, cond: f(e.cond), ifTrue: f(e.ifTrue), ifFalse: f(e.ifFalse) }
    case 'matchExpr':
      return {
        ...e,
        scrutinee: f(e.scrutinee),
        cases: e.cases.map(([n, v]) => [n, f(v)] as const),
        default: f(e.default),
      }
  }
}

/** Visit every top-level expr in a stmt (and its nested bodies' top-level exprs). */
export function forEachTopExpr(s: Stmt, visit: (e: Expr) => void): void {
  switch (s.s) {
    case 'let':
      eachExpr(s.expr, visit)
      break
    case 'var':
      if (s.init !== undefined) eachExpr(s.init, visit)
      break
    case 'assign':
    case 'assignOp':
      eachExpr(s.target, visit)
      eachExpr(s.expr, visit)
      break
    case 'return':
      if (s.expr !== undefined) eachExpr(s.expr, visit)
      break
    case 'if':
      for (const a of s.arms) {
        eachExpr(a.cond, visit)
        for (const b of a.body) forEachTopExpr(b, visit)
      }
      if (s.elseBody) for (const b of s.elseBody) forEachTopExpr(b, visit)
      break
    case 'for':
      forEachTopExpr(s.init, visit)
      eachExpr(s.cond, visit)
      forEachTopExpr(s.update, visit)
      for (const b of s.body) forEachTopExpr(b, visit)
      break
    case 'switch':
      eachExpr(s.scrut, visit)
      for (const c of s.cases) for (const b of c.body) forEachTopExpr(b, visit)
      if (s.defaultBody) for (const b of s.defaultBody) forEachTopExpr(b, visit)
      break
    default:
      break
  }
}

/** Apply `f` to each top-level expr of a stmt (f does its own recursion). */
export function mapStmtTop(s: Stmt, f: (e: Expr) => Expr): Stmt {
  switch (s.s) {
    case 'let':
      return { ...s, expr: f(s.expr) }
    case 'var':
      return s.init !== undefined ? { ...s, init: f(s.init) } : s
    case 'assign':
    case 'assignOp':
      return { ...s, target: f(s.target), expr: f(s.expr) }
    case 'return':
      return s.expr !== undefined ? { ...s, expr: f(s.expr) } : s
    case 'if':
      return {
        ...s,
        arms: s.arms.map((a) => ({ cond: f(a.cond), body: a.body.map((b) => mapStmtTop(b, f)) })),
        elseBody: s.elseBody?.map((b) => mapStmtTop(b, f)),
      }
    case 'for':
      return {
        ...s,
        init: mapStmtTop(s.init, f),
        cond: f(s.cond),
        update: mapStmtTop(s.update, f),
        body: s.body.map((b) => mapStmtTop(b, f)),
      }
    case 'switch':
      return {
        ...s,
        scrut: f(s.scrut),
        cases: s.cases.map((c) => ({ value: c.value, body: c.body.map((b) => mapStmtTop(b, f)) })),
        defaultBody: s.defaultBody?.map((b) => mapStmtTop(b, f)),
      }
    default:
      return s
  }
}

/** True iff any Stmt in `body` (recursively) is a raw WGSL Stmt. */
export function bodyHasRaw(body: readonly Stmt[]): boolean {
  for (const s of body) {
    if (s.s === 'raw') return true
    if (s.s === 'if') {
      if (s.arms.some((a) => bodyHasRaw(a.body))) return true
      if (s.elseBody && bodyHasRaw(s.elseBody)) return true
    } else if (s.s === 'for') {
      if (bodyHasRaw(s.body)) return true
    } else if (s.s === 'switch') {
      if (s.cases.some((c) => bodyHasRaw(c.body))) return true
      if (s.defaultBody && bodyHasRaw(s.defaultBody)) return true
    }
  }
  return false
}

/** Collect every function-local binding name (let / var / for-counter). */
export function collectLocals(body: readonly Stmt[], out: Set<string>): void {
  for (const s of body) {
    if (s.s === 'let' || s.s === 'var') out.add(s.name)
    else if (s.s === 'if') {
      for (const a of s.arms) collectLocals(a.body, out)
      if (s.elseBody) collectLocals(s.elseBody, out)
    } else if (s.s === 'for') {
      collectLocals([s.init], out)
      collectLocals(s.body, out)
    } else if (s.s === 'switch') {
      for (const c of s.cases) collectLocals(c.body, out)
      if (s.defaultBody) collectLocals(s.defaultBody, out)
    }
  }
}

/** True iff `e` references a local (a varref whose name is in `locals`). */
export function refsLocal(e: Expr, locals: ReadonlySet<string>): boolean {
  let yes = false
  eachExpr(e, (x) => {
    if (x.op === 'varref' && locals.has(x.name)) yes = true
  })
  return yes
}

/** The root varref name written by an assignment lvalue (`buf.v`/`arr[i]` -> `buf`/`arr`). */
function targetRoot(e: Expr): string | undefined {
  if (e.op === 'varref') return e.name
  if (e.op === 'member') return targetRoot(e.base)
  if (e.op === 'index') return targetRoot(e.base)
  return undefined
}

/** Collect every name MUTATED by an assignment in `body` (the assign-target roots).
 *  A read of a mutated name — including a `read_write` storage binding — is NOT
 *  invariant, so CSE / LICM must exclude any expr that references one (else they
 *  hoist a changing value and rewrite the store target into an immutable temp). */
export function collectMutatedRoots(body: readonly Stmt[], out: Set<string>): void {
  for (const s of body) {
    if (s.s === 'assign' || s.s === 'assignOp') {
      const r = targetRoot(s.target)
      if (r !== undefined) out.add(r)
    } else if (s.s === 'if') {
      for (const a of s.arms) collectMutatedRoots(a.body, out)
      if (s.elseBody) collectMutatedRoots(s.elseBody, out)
    } else if (s.s === 'for') {
      collectMutatedRoots([s.init], out)
      collectMutatedRoots([s.update], out)
      collectMutatedRoots(s.body, out)
    } else if (s.s === 'switch') {
      for (const c of s.cases) collectMutatedRoots(c.body, out)
      if (s.defaultBody) collectMutatedRoots(s.defaultBody, out)
    }
  }
}
