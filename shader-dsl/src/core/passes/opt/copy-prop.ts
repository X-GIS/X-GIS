// ═══ Shader DSL — copy propagation pass (Optimization context) ═══
//
// Substitutes a function-local `let y = x` binding — where the right-hand side is
// a bare COPY of a param / varref / constref (no computation) — into every read of
// `y`, when neither `y` nor the source is ever reassigned. Pure reference renaming
// (no arithmetic), so the result is bit-identical (f32-safe). After propagation
// the binding is usually dead; DCE removes it.
//
// A chain (`let y = x; let z = y`) collapses one level per run — `fixpoint` (see
// optimize.ts) iterates the rest. SCOPE is the shared substitution skeleton's, as
// for const-prop: `collectLets` (expr-utils.ts) owns the flat per-function map,
// `mapModuleExprsPerFunc` (ir-transform.ts) owns the raw-Stmt skip.

import type { Expr, ModuleDecl } from '../../ir/index.js'
import { mapModuleExprsPerFunc } from './ir-transform.js'
import { collectLets, collectMutatedRoots } from './expr-utils.js'

/** A "copy" RHS = a leaf reference with no computation: param / varref / constref. */
function isCopySource(e: Expr): e is Extract<Expr, { op: 'param' | 'varref' | 'constref' }> {
  return e.op === 'param' || e.op === 'varref' || e.op === 'constref'
}

/** Propagate bare copy bindings (let y = x) into their uses. Pure (module -> module). */
export function copyProp(m: ModuleDecl): ModuleDecl {
  return mapModuleExprsPerFunc(m, (f) => {
    const mutated = new Set<string>()
    collectMutatedRoots(f.body, mutated)
    const copies = collectLets(
      f.body,
      (name, e): e is Extract<Expr, { op: 'param' | 'varref' | 'constref' }> =>
        isCopySource(e) &&
        !mutated.has(name) &&
        // a constref is immutable; a param/varref source must itself never be reassigned
        (e.op === 'constref' || !mutated.has(e.name)),
    )
    if (copies.size === 0) return undefined
    return (e) => (e.op === 'varref' && copies.has(e.name) ? copies.get(e.name)! : e)
  })
}
