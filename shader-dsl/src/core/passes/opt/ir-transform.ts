// ═══ Shader DSL — IR transform toolkit (Optimization context) ═══
//
// Pure, structure-preserving rewrites over the Expr/Stmt IR, shared by every
// optimization pass. `mapExpr` is BOTTOM-UP: it rewrites a node's children first,
// then applies `f` to the rebuilt node — so a pass that folds one level (e.g.
// const-fold) collapses a whole nested literal tree in a single traversal. The
// IR is treated as immutable: every helper returns a new node, never mutates.

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir/index.js'
import { mapStmtExpr } from '../../ir/visit.js'
import { bodyHasRaw } from './dce.js'

/** Bottom-up expression rewrite: map children first, then apply `f` to the
 *  rebuilt node. */
export function mapExpr(e: Expr, f: (e: Expr) => Expr): Expr {
  let r: Expr
  switch (e.op) {
    case 'lit':
    case 'constref':
    case 'externref':
    case 'overrideref':
    case 'param':
    case 'varref':
      // `overrideref` (#923) is a leaf here just like `constref` — no children to
      // rewrite. This is WHERE its optimizer-opacity comes from: const-fold /
      // const-prop / dead-branch all rebuild through mapExpr, and a node they neither
      // descend into nor have a fold rule for passes through unchanged, so a branch
      // guarded by a specialization constant always survives for the driver.
      r = e
      break
    case 'binop':
      r = { ...e, a: mapExpr(e.a, f), b: mapExpr(e.b, f) }
      break
    case 'compare':
      r = { ...e, a: mapExpr(e.a, f), b: mapExpr(e.b, f) }
      break
    case 'logical':
      r = { ...e, a: mapExpr(e.a, f), b: mapExpr(e.b, f) }
      break
    case 'unop':
      r = { ...e, a: mapExpr(e.a, f) }
      break
    case 'call':
      r = { ...e, args: e.args.map((a) => mapExpr(a, f)) }
      break
    case 'construct':
      r = { ...e, args: e.args.map((a) => mapExpr(a, f)) }
      break
    case 'member':
      r = { ...e, base: mapExpr(e.base, f) }
      break
    case 'index':
      r = { ...e, base: mapExpr(e.base, f), idx: mapExpr(e.idx, f) }
      break
    case 'select':
      r = {
        ...e,
        cond: mapExpr(e.cond, f),
        ifTrue: mapExpr(e.ifTrue, f),
        ifFalse: mapExpr(e.ifFalse, f),
      }
      break
    case 'matchExpr':
      r = {
        ...e,
        scrutinee: mapExpr(e.scrutinee, f),
        cases: e.cases.map(([n, v]) => [n, mapExpr(v, f)] as const),
        default: mapExpr(e.default, f),
      }
      break
  }
  return f(r)
}

/** Rewrite every Expr inside a Stmt (and its nested bodies) via `mapExpr` — the
 *  bottom-up flavour of the shared statement rewrite, for passes that fold whole
 *  expression trees. */
export function mapStmt(s: Stmt, f: (e: Expr) => Expr): Stmt {
  return mapStmtExpr(
    s,
    (e) => mapExpr(e, f),
    (b) => mapStmt(b, f),
  )
}

/** Apply an Expr rewrite to every function body in a module. With
 *  `skipRawBodies` (#763 P1) a fn containing a raw WGSL Stmt is returned
 *  UNTOUCHED — the "raw fns emit verbatim" charter (wgsl.ts) applies to
 *  value-rewriting passes too; constFold/algebraicSimplify were the only two
 *  DEFAULT_PASSES without the skip, i.e. exactly the passes that CHANGE
 *  ARITHMETIC around precision-critical raw splices. */
export function mapModuleExprs(
  m: ModuleDecl,
  f: (e: Expr) => Expr,
  opts?: { skipRawBodies?: boolean },
): ModuleDecl {
  return {
    ...m,
    funcs: m.funcs.map((fn): FuncDecl =>
      opts?.skipRawBodies && bodyHasRaw(fn.body)
        ? fn
        : { ...fn, body: fn.body.map((s) => mapStmt(s, f)) },
    ),
  }
}
