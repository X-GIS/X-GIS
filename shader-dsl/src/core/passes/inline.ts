// ═══ Shader DSL — function inlining (Composition context) ═══
//
// inlineFn(module, name) replaces every call to a SINGLE-RETURN-EXPRESSION
// function with that function's return expression, substituting the formal params
// with the call's argument exprs; the function is dropped once no longer called.
//
// This is the IR-level composition primitive that will retire the polygon
// string-splice composer (placeholder/raw, #8) — the variant fill/stroke "return"
// is exactly a single-return fn inlined at the injection site. v1 handles only
// single-return fns (the variant shape); multi-statement inlining (temps + a
// captured result) is a later step. Pure (module -> module), pinned by oracle
// value-equality.

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../ir'
import { mapExpr, mapStmt } from './opt/ir-transform'

/** Substitute param/varref names in `e` with their mapped argument expr. */
function substParams(e: Expr, subst: ReadonlyMap<string, Expr>): Expr {
  return mapExpr(e, (x) =>
    (x.op === 'param' || x.op === 'varref') && subst.has(x.name) ? subst.get(x.name)! : x,
  )
}

/** True iff `body` contains a call to `name`. */
function callsFn(body: readonly Stmt[], name: string): boolean {
  let found = false
  const probe = (e: Expr): Expr => {
    if (e.op === 'call' && e.fn === name) found = true
    return e
  }
  for (const s of body) mapStmt(s, probe)
  return found
}

export function inlineFn(m: ModuleDecl, fnName: string): ModuleDecl {
  const target = m.funcs.find((f) => f.name === fnName)
  if (!target) return m
  const only = target.body.length === 1 ? target.body[0] : undefined
  if (!only || only.s !== 'return' || only.expr === undefined) return m // v1: single-return only
  const retExpr = only.expr

  const inlineCall = (e: Expr): Expr => {
    if (e.op === 'call' && e.fn === fnName) {
      const subst = new Map<string, Expr>()
      // args are already inlined (mapExpr is bottom-up), so substitution is one-shot.
      target.params.forEach((p, i) => {
        if (e.args[i] !== undefined) subst.set(p.name, e.args[i])
      })
      return substParams(retExpr, subst)
    }
    return e
  }

  const others = m.funcs
    .filter((f) => f.name !== fnName)
    .map((f): FuncDecl => ({ ...f, body: f.body.map((s) => mapStmt(s, inlineCall)) }))

  // Keep the target only if something still calls it (e.g. a recursive use we skipped).
  const stillCalled = others.some((f) => callsFn(f.body, fnName))
  return { ...m, funcs: stillCalled ? [target, ...others] : others }
}
