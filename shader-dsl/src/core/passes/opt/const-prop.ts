// ═══ Shader DSL — constant propagation pass (Optimization context) ═══
//
// Substitutes a function-local `let name = <literal>` binding into every read of
// `name`, when `name` is never reassigned. This is pure literal MOVEMENT — no
// arithmetic is performed — so the result is bit-identical to the original (this
// pass alone is even f32-safe; it is const-FOLD, *combining* two propagated
// literals, that needs the P3 f32 differential). After propagation the binding is
// usually dead; DCE (run later) removes it.
//
// SCOPE is the shared substitution skeleton's: `collectLets` (expr-utils.ts) owns
// the flat per-function map and why it needs no block scoping;
// `mapModuleExprsPerFunc` (ir-transform.ts) owns skipping a fn with a raw Stmt.
// What is THIS pass is the one line below — which bindings it admits.

import type { Expr, ModuleDecl } from '../../ir/index.js'
import { mapModuleExprsPerFunc } from './ir-transform.js'
import { collectLets, collectMutatedRoots } from './expr-utils.js'

/** Propagate literal-bound, never-reassigned locals into their uses. Pure (module -> module). */
export function constProp(m: ModuleDecl): ModuleDecl {
  return mapModuleExprsPerFunc(m, (f) => {
    const mutated = new Set<string>()
    collectMutatedRoots(f.body, mutated)
    const consts = collectLets(
      f.body,
      (name, e): e is Extract<Expr, { op: 'lit' }> => e.op === 'lit' && !mutated.has(name),
    )
    if (consts.size === 0) return undefined
    return (e) => (e.op === 'varref' && consts.has(e.name) ? consts.get(e.name)! : e)
  })
}
