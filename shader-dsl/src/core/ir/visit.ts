// ═══ Shader DSL — the Expr/Stmt traversal SoT ═══
//
// ONE walker per OPERATION over the closed `Expr` / `Stmt` unions, so the shape of
// the IR is written down once and every pass, backend and analysis inherits a new
// node kind by construction. Before this module the same `switch (s.s)` was
// hand-written in the builder's call collector, two fp64 closure walks, four GLSL
// backend rewrites, the mangler, the semantic differ, the reference collector and
// the optimizer toolkit — the exact "two paths that must agree, drifting silently"
// archetype this repo's duplication ratchet exists to stop (ADR-0013 decision 4;
// audit rows 1 and 8). `collect-refs.ts` already stated the invariant for its own
// pair of consumers; this generalises it to the whole package.
//
// FOUR functions — read and rewrite, over an Expr tree and over the Stmt shape:
//   • `eachExpr`      — read-only walk of an expression TREE (pre-order).
//   • `mapChildren`   — rebuild ONE Expr with its direct children rewritten; the
//                       caller owns the recursion, so a rewrite that intercepts at
//                       some ops (a storage read, a renamed call) spells only those.
//   • `eachStmtExpr`  — read-only walk of the STATEMENT shape: the Exprs a Stmt
//                       directly holds, plus its nested bodies.
//   • `mapStmtExpr`   — the same statement shape, REBUILT with each held Expr
//                       replaced. A rewrite and a walk have different return types
//                       and a rewrite allocates; folding one into the other buys a
//                       throwaway tree per read-only walk and hides both.
//
// OPEN RECURSION (`onStmt`) is why one statement walker covers every caller. A
// caller with a statement-level concern of its own — renaming a `let`/`var`
// declaration, intercepting a storage write — passes its OWN statement function,
// which is then used for the nested bodies too, so the special case applies at every
// depth. Omit it and the walk recurses through this module (the common case).
//
// `eachStmtExpr` hands the callback the Expr SLOT, not every node beneath it: the
// callers that want the whole subtree already own an expression walker with their
// own payload, and they compose (`eachStmtExpr(s, (e) => eachExpr(e, visit))`).
//
// VISIT ORDER is part of the contract: slots in source order (`assign` target
// before value; `for` init, cond, update, body). Several callers accumulate into a
// `Set` whose iteration order reaches emitted text, so reordering here would move
// bytes.

import type { Expr, Stmt } from './nodes.js'

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
      break // lit / constref / externref / overrideref / param / varref — leaves
  }
}

/** Rebuild `e` with `f` applied to its direct children only (self untouched). */
export function mapChildren(e: Expr, f: (c: Expr) => Expr): Expr {
  switch (e.op) {
    case 'lit':
    case 'constref':
    case 'overrideref':
    case 'externref':
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

/** Visit every Expr `s` directly holds, recursing into its nested bodies.
 *
 *  `onStmt` overrides how a nested statement is walked (open recursion); omit it and
 *  the nested walk comes back here with the same `visit`. */
export function eachStmtExpr(s: Stmt, visit: (e: Expr) => void, onStmt?: (s: Stmt) => void): void {
  const S = onStmt ?? ((b: Stmt): void => eachStmtExpr(b, visit))
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
    case 'if':
      for (const a of s.arms) {
        visit(a.cond)
        for (const b of a.body) S(b)
      }
      if (s.elseBody) for (const b of s.elseBody) S(b)
      break
    case 'for':
      S(s.init)
      visit(s.cond)
      S(s.update)
      for (const b of s.body) S(b)
      break
    case 'switch':
      visit(s.scrut)
      for (const c of s.cases) for (const b of c.body) S(b)
      if (s.defaultBody) for (const b of s.defaultBody) S(b)
      break
    default:
      break // break / continue / discard / placeholder / raw — no Expr to walk
  }
}

/** Rebuild `s` with `f` applied to every Expr it directly holds (`f` does its own
 *  descent into the expression tree) and its nested bodies rebuilt.
 *
 *  `onStmt` overrides how a nested statement is rebuilt (open recursion); omit it and
 *  the nested rebuild comes back here with the same `f`. A statement with no Expr —
 *  and a `var` with no initialiser — is returned UNCHANGED, so an untouched subtree
 *  keeps its identity. */
export function mapStmtExpr(s: Stmt, f: (e: Expr) => Expr, onStmt?: (s: Stmt) => Stmt): Stmt {
  const S = onStmt ?? ((b: Stmt): Stmt => mapStmtExpr(b, f))
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
        arms: s.arms.map((a) => ({ cond: f(a.cond), body: a.body.map(S) })),
        elseBody: s.elseBody?.map(S),
      }
    case 'for':
      return {
        ...s,
        init: S(s.init),
        cond: f(s.cond),
        update: S(s.update),
        body: s.body.map(S),
      }
    case 'switch':
      return {
        ...s,
        scrut: f(s.scrut),
        cases: s.cases.map((c) => ({ value: c.value, body: c.body.map(S) })),
        defaultBody: s.defaultBody?.map(S),
      }
    default:
      return s // break / continue / discard / placeholder / raw — no Expr to rewrite
  }
}
