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

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir/index.js'
import {
  keyOf,
  isCompound,
  eachExpr,
  mapChildren,
  bodyHasRaw,
  collectLocals,
  collectMutatedRoots,
  refsLocal,
  isWorthHoisting,
  mapStmtValue,
} from './expr-utils.js'

interface Tally {
  counts: Map<string, number>
  condKeys: Set<string> // keys with ≥1 conditionally-evaluated occurrence
  exemplar: Map<string, Expr>
}

// Walk `e`, tallying compound + worth-hoisting + LOCAL-touching subexprs, propagating a
// `cond` flag through short-circuit / branch operands so guarded repeats are excluded.
function tally(
  e: Expr,
  cond: boolean,
  localSet: ReadonlySet<string>,
  t: Tally,
  loadRoots: ReadonlySet<string>,
): void {
  if (isCompound(e) && isWorthHoisting(e, loadRoots) && refsLocal(e, localSet)) {
    const k = keyOf(e)
    t.counts.set(k, (t.counts.get(k) ?? 0) + 1)
    if (cond) t.condKeys.add(k)
    if (!t.exemplar.has(k)) t.exemplar.set(k, e)
  }
  switch (e.op) {
    case 'logical':
      tally(e.a, cond, localSet, t, loadRoots)
      tally(e.b, true, localSet, t, loadRoots)
      break // RHS short-circuits
    case 'select':
      tally(e.cond, cond, localSet, t, loadRoots)
      tally(e.ifTrue, true, localSet, t, loadRoots)
      tally(e.ifFalse, true, localSet, t, loadRoots)
      break
    case 'matchExpr':
      tally(e.scrutinee, cond, localSet, t, loadRoots)
      for (const [, v] of e.cases) tally(v, true, localSet, t, loadRoots)
      tally(e.default, true, localSet, t, loadRoots)
      break
    case 'binop':
    case 'compare':
      tally(e.a, cond, localSet, t, loadRoots)
      tally(e.b, cond, localSet, t, loadRoots)
      break
    case 'unop':
      tally(e.a, cond, localSet, t, loadRoots)
      break
    case 'call':
    case 'construct':
      for (const a of e.args) tally(a, cond, localSet, t, loadRoots)
      break
    case 'member':
      tally(e.base, cond, localSet, t, loadRoots)
      break
    case 'index':
      tally(e.base, cond, localSet, t, loadRoots)
      tally(e.idx, cond, localSet, t, loadRoots)
      break
    default:
      break // leaf
  }
}

// The exprs of a statement that are evaluated UNCONDITIONALLY, i.e. the ones a temp
// may be hoisted ahead of. NOT the lvalue target.
//
// An `if`'s FIRST arm condition is one of them (#1886). It runs whenever the statement
// runs, exactly like a `let` initialiser, so a `let` placed before the `if` costs
// nothing — and `processBody` already splices this pass's temps in ahead of the
// statement they came from, so the placement needs no new machinery. It used to be
// absent: `default: []` covered every control-flow statement and only the nested
// BODIES were recursed. Measured on the baked corpus after gvn got the same fix, the
// leftovers are almost all here — 119 within-statement repeats inside control-flow
// headers against 4 inside plain statements.
//
// Still absent, each because the expr is not evaluated once per execution:
//   • `arms[1..]` — an `else if` runs only when every earlier arm failed, the same
//     reason `tally` already refuses a `&&`/`||` RHS and a `select` branch;
//   • `for` cond — re-evaluated per iteration, so lifting it is loop invariance (licm);
//   • `switch` scrut — unconditional and sound to add, but 26 headers in the whole
//     production corpus against 2363 `if`s, so it waits for a measurement of its own.
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
    case 'if':
      return s.arms.length > 0 ? [s.arms[0]!.cond] : []
    default:
      return []
  }
}

// Hoist within-statement repeats of `s` → { the new `let` temps, the rewritten s }.
function hoistInStatement(
  s: Stmt,
  localSet: ReadonlySet<string>,
  next: { n: number },
  loadRoots: ReadonlySet<string>,
): { lets: Stmt[]; stmt: Stmt } {
  const exprs = valueExprs(s)
  if (exprs.length === 0) return { lets: [], stmt: s }

  const t: Tally = { counts: new Map(), condKeys: new Set(), exemplar: new Map() }
  for (const e of exprs) tally(e, false, localSet, t, loadRoots)

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
  loadRoots: ReadonlySet<string>,
): Stmt[] {
  const out: Stmt[] = []
  for (const s of body) {
    const rec = recurseBlocks(s, localSet, next, loadRoots)
    const { lets, stmt } = hoistInStatement(rec, localSet, next, loadRoots)
    out.push(...lets, stmt)
  }
  return out
}

// Rebuild a control-flow statement with its nested bodies processed; simple statements
// pass through (their own exprs are handled by hoistInStatement).
function recurseBlocks(
  s: Stmt,
  localSet: ReadonlySet<string>,
  next: { n: number },
  loadRoots: ReadonlySet<string>,
): Stmt {
  switch (s.s) {
    case 'if':
      return {
        ...s,
        arms: s.arms.map((a) => ({
          cond: a.cond,
          body: processBody(a.body, localSet, next, loadRoots),
        })),
        elseBody: s.elseBody ? processBody(s.elseBody, localSet, next, loadRoots) : undefined,
      }
    case 'for':
      return { ...s, body: processBody(s.body, localSet, next, loadRoots) }
    case 'switch':
      return {
        ...s,
        cases: s.cases.map((c) => ({
          value: c.value,
          body: processBody(c.body, localSet, next, loadRoots),
        })),
        defaultBody: s.defaultBody
          ? processBody(s.defaultBody, localSet, next, loadRoots)
          : undefined,
      }
    default:
      return s
  }
}

function cseLocalFn(f: FuncDecl, loadRoots: ReadonlySet<string>): FuncDecl {
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
  return { ...f, body: processBody(f.body, localSet, next, loadRoots) }
}

/** Hoist statement-local repeated subexpressions to a `let` before their statement.
 *  Pure (module → module); complements the fn-top `cse`. */
export function cseLocal(m: ModuleDecl): ModuleDecl {
  // Indexing one of these is a memory load, not free addressing (#1886).
  const loadRoots = new Set(m.bindings.map((b) => b.name))
  return { ...m, funcs: m.funcs.map((f) => cseLocalFn(f, loadRoots)) }
}
