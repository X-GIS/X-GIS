// ═══ Shader DSL — common-subexpression elimination (Optimization context) ═══
//
// Hoists a compound subexpression that occurs >= 2x and depends ONLY on fn
// inputs (params / consts / bindings — no local `let`) into a single `let` at the
// fn top, replacing each occurrence with a varref. This is a PASS over the IR,
// not an authoring change (the critic's "hash-consing rebuilds authoring" risk
// does not apply — `new Node(...)` is untouched).
//
// SAFE SUBSET (v1): only "independent" repeated exprs are hoisted — a selected
// expr that nests another selected expr is skipped (the inner one is hoisted
// instead), so no ordering/nesting interaction. A fn containing a raw Stmt is
// skipped (raw WGSL is opaque). Correctness is pinned by oracle value-equality.

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir'
import { typeKey } from '../../ir'

// ── structural key (two structurally-equal exprs share a key) ──
function keyOf(e: Expr): string {
  switch (e.op) {
    case 'lit': return `L:${typeof e.value}:${String(e.value)}`
    case 'constref': return `C:${e.name}`
    case 'param': return `P:${e.name}`
    case 'varref': return `V:${e.name}`
    case 'binop': return `(${keyOf(e.a)}${e.bop}${keyOf(e.b)})`
    case 'compare': return `(${keyOf(e.a)}${e.cop}${keyOf(e.b)})`
    case 'logical': return `(${keyOf(e.a)}${e.lop}${keyOf(e.b)})`
    case 'unop': return `(-${keyOf(e.a)})`
    case 'call': return `${e.fn}(${e.args.map(keyOf).join(',')})`
    case 'construct': return `${typeKey(e.type)}{${e.args.map(keyOf).join(',')}}`
    case 'member': return `${keyOf(e.base)}.${e.field}`
    case 'index': return `${keyOf(e.base)}[${keyOf(e.idx)}]`
    case 'select': return `S(${keyOf(e.cond)},${keyOf(e.ifTrue)},${keyOf(e.ifFalse)})`
    case 'matchExpr': return `M(${keyOf(e.scrutinee)};${e.cases.map(([n, v]) => `${n}:${keyOf(v)}`).join(',')};${keyOf(e.default)})`
  }
}

const isCompound = (e: Expr): boolean =>
  e.op !== 'lit' && e.op !== 'constref' && e.op !== 'param' && e.op !== 'varref'

/** Visit `e` and every descendant (pre-order). */
function eachExpr(e: Expr, visit: (e: Expr) => void): void {
  visit(e)
  switch (e.op) {
    case 'binop': case 'compare': case 'logical': eachExpr(e.a, visit); eachExpr(e.b, visit); break
    case 'unop': eachExpr(e.a, visit); break
    case 'call': case 'construct': for (const a of e.args) eachExpr(a, visit); break
    case 'member': eachExpr(e.base, visit); break
    case 'index': eachExpr(e.base, visit); eachExpr(e.idx, visit); break
    case 'select': eachExpr(e.cond, visit); eachExpr(e.ifTrue, visit); eachExpr(e.ifFalse, visit); break
    case 'matchExpr': eachExpr(e.scrutinee, visit); for (const [, v] of e.cases) eachExpr(v, visit); eachExpr(e.default, visit); break
    default: break
  }
}

/** Rebuild `e` with `f` applied to its direct children only (self untouched). */
function mapChildren(e: Expr, f: (c: Expr) => Expr): Expr {
  switch (e.op) {
    case 'lit': case 'constref': case 'param': case 'varref': return e
    case 'binop': return { ...e, a: f(e.a), b: f(e.b) }
    case 'compare': return { ...e, a: f(e.a), b: f(e.b) }
    case 'logical': return { ...e, a: f(e.a), b: f(e.b) }
    case 'unop': return { ...e, a: f(e.a) }
    case 'call': return { ...e, args: e.args.map(f) }
    case 'construct': return { ...e, args: e.args.map(f) }
    case 'member': return { ...e, base: f(e.base) }
    case 'index': return { ...e, base: f(e.base), idx: f(e.idx) }
    case 'select': return { ...e, cond: f(e.cond), ifTrue: f(e.ifTrue), ifFalse: f(e.ifFalse) }
    case 'matchExpr': return { ...e, scrutinee: f(e.scrutinee), cases: e.cases.map(([n, v]) => [n, f(v)] as const), default: f(e.default) }
  }
}

function forEachTopExpr(s: Stmt, visit: (e: Expr) => void): void {
  switch (s.s) {
    case 'let': eachExpr(s.expr, visit); break
    case 'var': if (s.init !== undefined) eachExpr(s.init, visit); break
    case 'assign': case 'assignOp': eachExpr(s.target, visit); eachExpr(s.expr, visit); break
    case 'return': if (s.expr !== undefined) eachExpr(s.expr, visit); break
    case 'if':
      for (const a of s.arms) { eachExpr(a.cond, visit); for (const b of a.body) forEachTopExpr(b, visit) }
      if (s.elseBody) for (const b of s.elseBody) forEachTopExpr(b, visit)
      break
    case 'for':
      forEachTopExpr(s.init, visit); eachExpr(s.cond, visit); forEachTopExpr(s.update, visit)
      for (const b of s.body) forEachTopExpr(b, visit)
      break
    case 'switch':
      eachExpr(s.scrut, visit)
      for (const c of s.cases) for (const b of c.body) forEachTopExpr(b, visit)
      if (s.defaultBody) for (const b of s.defaultBody) forEachTopExpr(b, visit)
      break
    default: break
  }
}

function mapStmtTop(s: Stmt, f: (e: Expr) => Expr): Stmt {
  switch (s.s) {
    case 'let': return { ...s, expr: f(s.expr) }
    case 'var': return s.init !== undefined ? { ...s, init: f(s.init) } : s
    case 'assign': case 'assignOp': return { ...s, target: f(s.target), expr: f(s.expr) }
    case 'return': return s.expr !== undefined ? { ...s, expr: f(s.expr) } : s
    case 'if': return {
      ...s,
      arms: s.arms.map((a) => ({ cond: f(a.cond), body: a.body.map((b) => mapStmtTop(b, f)) })),
      elseBody: s.elseBody?.map((b) => mapStmtTop(b, f)),
    }
    case 'for': return { ...s, init: mapStmtTop(s.init, f), cond: f(s.cond), update: mapStmtTop(s.update, f), body: s.body.map((b) => mapStmtTop(b, f)) }
    case 'switch': return {
      ...s,
      scrut: f(s.scrut),
      cases: s.cases.map((c) => ({ value: c.value, body: c.body.map((b) => mapStmtTop(b, f)) })),
      defaultBody: s.defaultBody?.map((b) => mapStmtTop(b, f)),
    }
    default: return s
  }
}

function bodyHasRaw(body: readonly Stmt[]): boolean {
  let found = false
  for (const s of body) {
    if (s.s === 'raw') return true
    if (s.s === 'if') { if (s.arms.some((a) => bodyHasRaw(a.body)) || (s.elseBody && bodyHasRaw(s.elseBody))) found = true }
    else if (s.s === 'for') { if (bodyHasRaw(s.body)) found = true }
    else if (s.s === 'switch') { if (s.cases.some((c) => bodyHasRaw(c.body)) || (s.defaultBody && bodyHasRaw(s.defaultBody))) found = true }
  }
  return found
}

function collectLocals(body: readonly Stmt[], out: Set<string>): void {
  for (const s of body) {
    if (s.s === 'let' || s.s === 'var') out.add(s.name)
    else if (s.s === 'if') { for (const a of s.arms) collectLocals(a.body, out); if (s.elseBody) collectLocals(s.elseBody, out) }
    else if (s.s === 'for') { collectLocals([s.init], out); collectLocals(s.body, out) }
    else if (s.s === 'switch') { for (const c of s.cases) collectLocals(c.body, out); if (s.defaultBody) collectLocals(s.defaultBody, out) }
  }
}

/** True iff `e` references a local (a varref whose name is a fn-local let/var). */
function refsLocal(e: Expr, locals: ReadonlySet<string>): boolean {
  let yes = false
  eachExpr(e, (x) => { if (x.op === 'varref' && locals.has(x.name)) yes = true })
  return yes
}

function cseFn(f: FuncDecl): FuncDecl {
  if (bodyHasRaw(f.body)) return f
  const locals = new Set<string>()
  collectLocals(f.body, locals)

  // Count occurrences of every compound, input-only subexpression.
  const counts = new Map<string, number>()
  const exemplar = new Map<string, Expr>()
  for (const s of f.body) {
    forEachTopExpr(s, (e) => {
      if (!isCompound(e) || refsLocal(e, locals)) return
      const k = keyOf(e)
      counts.set(k, (counts.get(k) ?? 0) + 1)
      if (!exemplar.has(k)) exemplar.set(k, e)
    })
  }
  const repeated = new Set<string>([...counts].filter(([, n]) => n >= 2).map(([k]) => k))
  if (repeated.size === 0) return f

  // Keep only "independent" repeated exprs (no repeated proper sub-expr) — the
  // inner one is hoisted instead, so there is no ordering/nesting interaction.
  const independent = [...repeated].filter((k) => {
    const e = exemplar.get(k)!
    let nests = false
    eachExpr(e, (sub) => { if (sub !== e && repeated.has(keyOf(sub))) nests = true })
    return !nests
  })
  if (independent.length === 0) return f

  // Assign a temp per independent key; build the hoisted lets + replacement map.
  const temp = new Map<string, string>()
  const lets: Stmt[] = []
  independent.forEach((k, i) => {
    const name = `_cse${i}`
    temp.set(k, name)
    lets.push({ s: 'let', name, expr: exemplar.get(k)! })
  })

  const replace = (e: Expr): Expr => {
    const t = temp.get(keyOf(e))
    if (t !== undefined) return { op: 'varref', type: e.type, name: t }
    return mapChildren(e, replace)
  }
  const newBody = f.body.map((s) => mapStmtTop(s, replace))
  return { ...f, body: [...lets, ...newBody] }
}

/** Hoist repeated input-only subexpressions to shared temps. Pure (module -> module). */
export function cse(m: ModuleDecl): ModuleDecl {
  return { ...m, funcs: m.funcs.map(cseFn) }
}
