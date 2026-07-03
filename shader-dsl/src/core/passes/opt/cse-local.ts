// ═══ Shader DSL — statement-local common-subexpression elimination ═══
//
// The fn-top `cse` pass only hoists INPUT-ONLY repeats — it places the temp at the
// fn top, where function locals are not yet in scope, so it MUST exclude any expr that
// reads a local/var. That leaves the most common redundancy uncaught: a subexpression
// that touches a local/var but repeats WITHIN A SINGLE STATEMENT. Examples the authors
// had to hand-`Let`:
//   • `apply_log_depth(clip, fc).x/.y/.z/.w`  — 4× in one `return`; `clip` is a var
//   • a raymarch `normalize(p)` across 3 lighting dot-products in one assignment
//   • a per-iteration `hash(cell + g)` — the loop counters are vars
//
// SAFE because nothing mutates DURING a single statement's expression evaluation
// (assignments are statements, never expressions). So a subexpr that repeats within one
// statement holds the SAME value at every occurrence; binding it to a `let` inserted
// immediately BEFORE that statement (in the same block) preserves both the value and
// every dependency — nothing runs between the new let and the statement. Done per block
// and per NESTED block (if-arms / loop body), so a loop-body repeat is bound once per
// iteration (the let lands inside the loop).
//
// CONSERVATISM: a candidate is hoisted only if EVERY occurrence is UNCONDITIONALLY
// evaluated — never under a `&&`/`||` short-circuit RHS, a `select` branch, or a
// `matchExpr` arm — so the pass never lifts a guarded computation out of its guard.
// Only the value side of let/var/assign/return is rewritten (control-flow conditions
// and loop heads are left alone: a for-cond repeat would mis-bind once, not per-iter).
//
// Bit-exact (pure dedup — no float arithmetic is changed), so no f32 differential gate
// is needed; pinned by oracle value-equality like the sibling fn-top `cse`.

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir'
import {
  keyOf,
  isCompound,
  eachExpr,
  mapChildren,
  bodyHasRaw,
  collectLocals,
  collectMutatedRoots,
  refsLocal,
} from './expr-utils'

// Only hoist exprs that COMPUTE — a bare member/swizzle/index navigation is as cheap
// inlined as bound (mirrors cse.ts isWorthHoisting).
function isWorthHoisting(e: Expr): boolean {
  let computes = false
  eachExpr(e, (x) => {
    if (
      x.op === 'binop' ||
      x.op === 'unop' ||
      x.op === 'compare' ||
      x.op === 'logical' ||
      x.op === 'call' ||
      x.op === 'construct' ||
      x.op === 'select' ||
      x.op === 'matchExpr'
    )
      computes = true
  })
  return computes
}

interface Tally {
  counts: Map<string, number>
  condKeys: Set<string> // keys with ≥1 conditionally-evaluated occurrence
  exemplar: Map<string, Expr>
}

// Walk `e`, tallying compound + worth-hoisting + LOCAL-touching subexprs, propagating a
// `cond` flag through short-circuit / branch operands so guarded repeats are excluded.
function tally(e: Expr, cond: boolean, localSet: ReadonlySet<string>, t: Tally): void {
  if (isCompound(e) && isWorthHoisting(e) && refsLocal(e, localSet)) {
    const k = keyOf(e)
    t.counts.set(k, (t.counts.get(k) ?? 0) + 1)
    if (cond) t.condKeys.add(k)
    if (!t.exemplar.has(k)) t.exemplar.set(k, e)
  }
  switch (e.op) {
    case 'logical':
      tally(e.a, cond, localSet, t)
      tally(e.b, true, localSet, t)
      break // RHS short-circuits
    case 'select':
      tally(e.cond, cond, localSet, t)
      tally(e.ifTrue, true, localSet, t)
      tally(e.ifFalse, true, localSet, t)
      break
    case 'matchExpr':
      tally(e.scrutinee, cond, localSet, t)
      for (const [, v] of e.cases) tally(v, true, localSet, t)
      tally(e.default, true, localSet, t)
      break
    case 'binop':
    case 'compare':
      tally(e.a, cond, localSet, t)
      tally(e.b, cond, localSet, t)
      break
    case 'unop':
      tally(e.a, cond, localSet, t)
      break
    case 'call':
    case 'construct':
      for (const a of e.args) tally(a, cond, localSet, t)
      break
    case 'member':
      tally(e.base, cond, localSet, t)
      break
    case 'index':
      tally(e.base, cond, localSet, t)
      tally(e.idx, cond, localSet, t)
      break
    default:
      break // leaf
  }
}

// The value-carrying exprs of a SIMPLE statement (the ones safe to hoist a temp before).
// Control-flow statements return [] — only their nested bodies are recursed (elsewhere).
function valueExprs(s: Stmt): readonly Expr[] {
  switch (s.s) {
    case 'let':
      return [s.expr]
    case 'var':
      return s.init !== undefined ? [s.init] : []
    case 'assign':
    case 'assignOp':
      return [s.expr] // NOT the lvalue target
    case 'return':
      return s.expr !== undefined ? [s.expr] : []
    default:
      return []
  }
}

// Rewrite only the value side of a simple statement (target lvalue untouched).
function mapStmtValue(s: Stmt, f: (e: Expr) => Expr): Stmt {
  switch (s.s) {
    case 'let':
      return { ...s, expr: f(s.expr) }
    case 'var':
      return s.init !== undefined ? { ...s, init: f(s.init) } : s
    case 'assign':
    case 'assignOp':
      return { ...s, expr: f(s.expr) }
    case 'return':
      return s.expr !== undefined ? { ...s, expr: f(s.expr) } : s
    default:
      return s
  }
}

// Hoist within-statement repeats of `s` → { the new `let` temps, the rewritten s }.
function hoistInStatement(
  s: Stmt,
  localSet: ReadonlySet<string>,
  next: { n: number },
): { lets: Stmt[]; stmt: Stmt } {
  const exprs = valueExprs(s)
  if (exprs.length === 0) return { lets: [], stmt: s }

  const t: Tally = { counts: new Map(), condKeys: new Set(), exemplar: new Map() }
  for (const e of exprs) tally(e, false, localSet, t)

  const repeated = [...t.counts].filter(([k, n]) => n >= 2 && !t.condKeys.has(k)).map(([k]) => k)
  if (repeated.length === 0) return { lets: [], stmt: s }

  // Keep only the MAXIMAL repeats (outermost): hoisting `normalize(p)` subsumes its inner
  // `p`, so a single temp covers the whole shared value (mirrors cse.ts).
  const repSet = new Set(repeated)
  const nested = new Set<string>()
  for (const k of repeated) {
    eachExpr(t.exemplar.get(k)!, (sub) => {
      if (sub === t.exemplar.get(k)) return
      const sk = keyOf(sub)
      if (repSet.has(sk)) nested.add(sk)
    })
  }
  const maximal = repeated.filter((k) => !nested.has(k))
  if (maximal.length === 0) return { lets: [], stmt: s }

  const temp = new Map<string, string>()
  const lets: Stmt[] = []
  for (const k of maximal) {
    const name = `_lc${next.n++}`
    temp.set(k, name)
    lets.push({ s: 'let', name, expr: t.exemplar.get(k)! })
  }
  const replace = (e: Expr): Expr => {
    const nm = temp.get(keyOf(e))
    if (nm !== undefined) return { op: 'varref', type: e.type, name: nm }
    return mapChildren(e, replace)
  }
  return { lets, stmt: mapStmtValue(s, replace) }
}

// Process a statement list: recurse into nested blocks FIRST (so inner statements get
// their own local-cse), then hoist within each statement, splicing the temps in ahead.
function processBody(
  body: readonly Stmt[],
  localSet: ReadonlySet<string>,
  next: { n: number },
): Stmt[] {
  const out: Stmt[] = []
  for (const s of body) {
    const rec = recurseBlocks(s, localSet, next)
    const { lets, stmt } = hoistInStatement(rec, localSet, next)
    out.push(...lets, stmt)
  }
  return out
}

// Rebuild a control-flow statement with its nested bodies processed; simple statements
// pass through (their own exprs are handled by hoistInStatement).
function recurseBlocks(s: Stmt, localSet: ReadonlySet<string>, next: { n: number }): Stmt {
  switch (s.s) {
    case 'if':
      return {
        ...s,
        arms: s.arms.map((a) => ({ cond: a.cond, body: processBody(a.body, localSet, next) })),
        elseBody: s.elseBody ? processBody(s.elseBody, localSet, next) : undefined,
      }
    case 'for':
      return { ...s, body: processBody(s.body, localSet, next) }
    case 'switch':
      return {
        ...s,
        cases: s.cases.map((c) => ({ value: c.value, body: processBody(c.body, localSet, next) })),
        defaultBody: s.defaultBody ? processBody(s.defaultBody, localSet, next) : undefined,
      }
    default:
      return s
  }
}

function cseLocalFn(f: FuncDecl): FuncDecl {
  if (bodyHasRaw(f.body)) return f // raw WGSL is opaque
  // "local" = every binding name AND every mutated root — exactly the set the fn-top cse
  // refuses to hoist. Targeting these makes this pass the complement of that one.
  const localSet = new Set<string>()
  collectLocals(f.body, localSet)
  collectMutatedRoots(f.body, localSet)
  // Seed the temp counter past any existing `_lcN` so a second fixpoint pass cannot
  // redeclare `_lc0` (cse-local runs repeatedly inside fixpoint).
  let base = 0
  for (const n of localSet) {
    const mm = /^_lc(\d+)$/.exec(n)
    if (mm) base = Math.max(base, Number(mm[1]) + 1)
  }
  const next = { n: base }
  return { ...f, body: processBody(f.body, localSet, next) }
}

/** Hoist statement-local repeated subexpressions to a `let` before their statement.
 *  Pure (module → module); complements the fn-top `cse`. */
export function cseLocal(m: ModuleDecl): ModuleDecl {
  return { ...m, funcs: m.funcs.map(cseLocalFn) }
}
