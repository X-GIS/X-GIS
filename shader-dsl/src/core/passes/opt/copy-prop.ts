// ═══ Shader DSL — copy propagation pass (Optimization context) ═══
//
// Substitutes a function-local `let y = x` binding — where the right-hand side is
// a bare COPY of a param / varref / constref (no computation) — into every read of
// `y`, when neither `y` nor the source is ever reassigned. Pure reference renaming
// (no arithmetic), so the result is bit-identical (f32-safe). After propagation
// the binding is usually dead; DCE removes it.
//
// A chain (`let y = x; let z = y`) collapses one level per run — `fixpoint` (see
// optimize.ts) iterates the rest. Same scope/raw rules as const-prop: names are
// unique per fn (flat map, no block scoping), a mutated source/target is excluded,
// a fn with a raw Stmt is skipped.

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir'
import { mapStmt } from './ir-transform'
import { bodyHasRaw, collectMutatedRoots } from './expr-utils'

/** A "copy" RHS = a leaf reference with no computation: param / varref / constref. */
function isCopySource(e: Expr): e is Extract<Expr, { op: 'param' | 'varref' | 'constref' }> {
  return e.op === 'param' || e.op === 'varref' || e.op === 'constref'
}

function collectCopies(
  body: readonly Stmt[],
  mutated: ReadonlySet<string>,
  out: Map<string, Expr>,
): void {
  for (const s of body) {
    if (
      s.s === 'let' &&
      isCopySource(s.expr) &&
      !mutated.has(s.name) &&
      // a constref is immutable; a param/varref source must itself never be reassigned
      (s.expr.op === 'constref' || !mutated.has(s.expr.name))
    )
      out.set(s.name, s.expr)
    else if (s.s === 'if') {
      for (const a of s.arms) collectCopies(a.body, mutated, out)
      if (s.elseBody) collectCopies(s.elseBody, mutated, out)
    } else if (s.s === 'for') {
      collectCopies([s.init], mutated, out)
      collectCopies(s.body, mutated, out)
    } else if (s.s === 'switch') {
      for (const c of s.cases) collectCopies(c.body, mutated, out)
      if (s.defaultBody) collectCopies(s.defaultBody, mutated, out)
    }
  }
}

function copyPropFn(f: FuncDecl): FuncDecl {
  if (bodyHasRaw(f.body)) return f
  const mutated = new Set<string>()
  collectMutatedRoots(f.body, mutated)
  const copies = new Map<string, Expr>()
  collectCopies(f.body, mutated, copies)
  if (copies.size === 0) return f
  const sub = (e: Expr): Expr => (e.op === 'varref' && copies.has(e.name) ? copies.get(e.name)! : e)
  return { ...f, body: f.body.map((s) => mapStmt(s, sub)) }
}

/** Propagate bare copy bindings (let y = x) into their uses. Pure (module -> module). */
export function copyProp(m: ModuleDecl): ModuleDecl {
  return { ...m, funcs: m.funcs.map(copyPropFn) }
}
