// ═══ Shader DSL — WGSL pre-emit transform pass ═══
//
// Lowers IR Exprs that the WGSL backend cannot emit directly into a shape
// the existing emitter understands. Today the only such Expr is `matchExpr`
// (Phase 2.5 US-001) — the wgsl backend has no native multi-arm conditional
// EXPRESSION; WGSL only has `switch` as a STATEMENT. The lowering hoists a
// `var _mr_N` slot + `Stmt.switch` ahead of the containing Stmt and
// rewrites the matchExpr position into a varref to the slot.
//
// `emitModule()` runs this pass first so the rest of the emitter stays
// matchExpr-unaware. The architect's rev-2 decision (ralplan step 3) keeps
// `emitExpr()` signature stable — no parent-context threading.
//
// Walk semantics:
//   1. lowerStmtList walks each Stmt list. For each Stmt:
//      a. Recurse into nested Stmt bodies (for/if/switch arms + defaultBody)
//         first via lowerSubStmts — matchExpr Exprs in those nested bodies
//         get their hoists INSIDE their own body's Stmt list, NOT bubbled
//         out (a var hoisted above a for loop and reassigned each iter
//         would change semantics in surprising ways).
//      b. Walk the Stmt's TOP-level Exprs via walkStmtExprs. For each
//         matchExpr Expr encountered, hoist `{ Stmt.var, Stmt.switch }`
//         into the current Stmt list immediately before the containing
//         Stmt; rewrite the matchExpr position to a varref.
//   2. Nested matchExprs (matchExpr in the value-Expr of an outer
//      matchExpr's case) are lowered inside-out by virtue of the
//      bottom-up Expr walk (walkExprChildren visits children before
//      examining the current node). The outer matchExpr therefore sees
//      varrefs in its cases when it's processed.
//   3. >=10-arm matchExprs cast non-integer scrutinees through i32() —
//      WGSL switch is integer-only. This is the matchExpr perf gate from
//      the ralplan AC2 (linear-scaling lookup for the variant-heavy
//      land-cover match chains).

import type { Expr, Stmt, FuncDecl, ModuleDecl } from '../ir/nodes'
import { i32T, type ShaderType } from '../ir/types'

interface Counter {
  n: number
}

export function lowerModule(m: ModuleDecl): ModuleDecl {
  return {
    ...m,
    funcs: m.funcs.map(lowerFunc),
  }
}

function lowerFunc(f: FuncDecl): FuncDecl {
  // Per-fn counter so slot names stay readable (`_mr_0`, `_mr_1`, …) and
  // the diff-test snapshots remain stable across re-emits.
  const counter: Counter = { n: 0 }
  return { ...f, body: lowerStmtList(f.body, counter) }
}

function lowerStmtList(stmts: readonly Stmt[], counter: Counter): Stmt[] {
  const out: Stmt[] = []
  for (const s of stmts) {
    const nested = lowerSubStmts(s, counter)
    const { hoisted, rewritten } = hoistMatchExprs(nested, counter)
    out.push(...hoisted, rewritten)
  }
  return out
}

function lowerSubStmts(s: Stmt, counter: Counter): Stmt {
  switch (s.s) {
    case 'for':
      return { ...s, body: lowerStmtList(s.body, counter) }
    case 'if':
      return {
        ...s,
        arms: s.arms.map((arm) => ({ ...arm, body: lowerStmtList(arm.body, counter) })),
        elseBody: s.elseBody ? lowerStmtList(s.elseBody, counter) : undefined,
      }
    case 'switch':
      return {
        ...s,
        cases: s.cases.map((c) => ({ ...c, body: lowerStmtList(c.body, counter) })),
        defaultBody: s.defaultBody ? lowerStmtList(s.defaultBody, counter) : undefined,
      }
    default:
      return s
  }
}

function hoistMatchExprs(s: Stmt, counter: Counter): { hoisted: Stmt[]; rewritten: Stmt } {
  const hoisted: Stmt[] = []

  const visit = (e: Expr): Expr => {
    // Bottom-up: rewrite children first so nested matchExprs lower deepest-first.
    const walked = walkExprChildren(e, visit)
    if (walked.op !== 'matchExpr') return walked

    const armCount = walked.cases.length
    const slotName = `_mr_${counter.n++}`
    const slotType: ShaderType = walked.type
    const slotRef: Expr = { op: 'varref', type: slotType, name: slotName }
    const assignSlot = (value: Expr): Stmt => ({ s: 'assign', target: slotRef, expr: value })

    // WGSL switch is integer-only. For >=10-arm matches we always emit a
    // Stmt.switch (the matchExpr perf gate); cast non-integer scrutinees
    // via i32() so the emitted WGSL parses. For <10-arm matches with a
    // non-integer scrutinee, the same cast still works — the entire
    // lowering path produces a Stmt.switch regardless of arm count
    // because the IR has no module-scope pure-expression context that
    // would need a nested select() chain (every matchExpr in this
    // codebase appears inside an fn body Stmt via the compiler retarget).
    const scrutType = walked.scrutinee.type
    const isIntegerScrut =
      scrutType.kind === 'scalar' && (scrutType.scalar === 'i32' || scrutType.scalar === 'u32')
    const scrut: Expr = isIntegerScrut
      ? walked.scrutinee
      : { op: 'call', type: i32T, fn: 'i32', args: [walked.scrutinee] }

    const switchStmt: Stmt = {
      s: 'switch',
      scrut,
      cases: walked.cases.map(([v, ve]) => ({ value: v, body: [assignSlot(ve)] })),
      defaultBody: [assignSlot(walked.default)],
    }
    hoisted.push({ s: 'var', name: slotName, type: slotType }, switchStmt)

    // The matchExpr Expr is replaced with a read of the slot var.
    return slotRef

    // Mark armCount as intentionally read (kept for future use such as a
    // <=9-arm nested select() lowering path).
    void armCount
  }

  const rewritten = walkStmtExprs(s, visit)
  return { hoisted, rewritten }
}

// ── Expr walker — bottom-up ──
//
// Returns a NEW Expr with each child replaced by `visit(child)`. Visit is
// responsible for the matchExpr hoist; non-matchExpr Exprs pass through
// unchanged. Leaves (lit / constref / param / varref) have no children so
// `visit` simply returns them.

/** Does this Expr tree contain a matchExpr anywhere? (#763 P3 — for-header guard.) */
function exprContainsMatch(e: Expr): boolean {
  if (e.op === 'matchExpr') return true
  let found = false
  walkExprChildren(e, (child) => {
    if (found || exprContainsMatch(child)) found = true
    return child
  })
  return found
}

function walkExprChildren(e: Expr, visit: (e: Expr) => Expr): Expr {
  switch (e.op) {
    case 'lit':
    case 'constref':
    case 'overrideref':
    case 'param':
    case 'varref':
      return e
    case 'binop':
    case 'compare':
    case 'logical':
      return { ...e, a: visit(e.a), b: visit(e.b) }
    case 'unop':
      return { ...e, a: visit(e.a) }
    case 'call':
      return { ...e, args: e.args.map(visit) }
    case 'member':
      return { ...e, base: visit(e.base) }
    case 'construct':
      return { ...e, args: e.args.map(visit) }
    case 'select':
      return { ...e, cond: visit(e.cond), ifTrue: visit(e.ifTrue), ifFalse: visit(e.ifFalse) }
    case 'index':
      return { ...e, base: visit(e.base), idx: visit(e.idx) }
    case 'matchExpr':
      return {
        ...e,
        scrutinee: visit(e.scrutinee),
        cases: e.cases.map(([n, v]) => [n, visit(v)] as const),
        default: visit(e.default),
      }
  }
}

// ── Stmt walker — top-level Exprs only ──
//
// `lowerSubStmts` already lowered sub-Stmt bodies (for/if/switch), so
// walkStmtExprs deliberately does NOT recurse into them. For for-init /
// for-update Stmts we walk their inner Exprs because those run as part of
// the for-stmt's evaluation, not in a sub-body — a matchExpr in for-update
// in particular would hoist out and only evaluate once, which is wrong;
// polygon codegen has no such use case, so we don't recurse into init/
// update either to avoid the subtle incorrect-hoist trap. If a future
// shader needs matchExpr in a for header, the lowering pass throws here
// (defensive — no silent semantic drift).

function walkStmtExprs(s: Stmt, visit: (e: Expr) => Expr): Stmt {
  switch (s.s) {
    case 'let':
      return { ...s, expr: visit(s.expr) }
    case 'var':
      return s.init !== undefined ? { ...s, init: visit(s.init) } : s
    case 'assign':
      return { ...s, target: visit(s.target), expr: visit(s.expr) }
    case 'assignOp':
      return { ...s, target: visit(s.target), expr: visit(s.expr) }
    case 'return':
      return s.expr !== undefined ? { ...s, expr: visit(s.expr) } : s
    case 'if':
      return {
        ...s,
        arms: s.arms.map((arm) => ({ ...arm, cond: visit(arm.cond), body: arm.body })),
      }
    case 'for': {
      // #763 P3 — the throw this file's header comment PROMISED but never had.
      // Hoisting a matchExpr out of a for-COND evaluates it ONCE where the loop
      // (and the CPU oracle) evaluate it per iteration — a silent CPU/GPU
      // divergence, author-reachable via forRange's cond callback. init/update
      // matchExprs would survive un-lowered and die later in emit with a
      // misleading "lowerModule should have hoisted it". Fail loud here instead.
      if (
        exprContainsMatch(s.cond) ||
        (s.init.s === 'var' && s.init.init !== undefined && exprContainsMatch(s.init.init)) ||
        (s.update.s === 'assign' && exprContainsMatch(s.update.expr))
      ) {
        throw new Error(
          'shader-dsl: matchExpr in a for-loop header (init/cond/update) is not lowerable — hoisting evaluates it once instead of per-iteration. Compute it into a var inside the loop body (or before the loop if truly invariant).',
        )
      }
      return s
    }
    case 'switch':
      return { ...s, scrut: visit(s.scrut) }
    case 'break':
    case 'continue':
    case 'discard':
    case 'raw': // Phase 2 PR 2e.B.2 — raw WGSL leaf, no sub-Expr to lower.
    case 'placeholder':
      return s // Phase 2.5 US-007 — leaf, no sub-Expr to lower.
  }
}
