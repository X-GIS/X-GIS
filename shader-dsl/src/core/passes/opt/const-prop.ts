// ═══ Shader DSL — constant propagation pass (Optimization context) ═══
//
// Substitutes a function-local `let name = <literal>` binding into every read of
// `name`, when `name` is never reassigned. This is pure literal MOVEMENT — no
// arithmetic is performed — so the result is bit-identical to the original (this
// pass alone is even f32-safe; it is const-FOLD, *combining* two propagated
// literals, that needs the P3 f32 differential). After propagation the binding is
// usually dead; DCE (run later) removes it.
//
// SCOPE — one flat map per function. Binding names are unique per function (the
// builder auto-names, and a name bound in one branch cannot be referenced from a
// sibling — see the oracle's flat-env note, oracle.ts), so a function-wide map
// needs no block scoping, exactly as DCE / LICM already assume. A name that is
// EVER an assignment target is excluded (its value changes). A fn containing a raw
// Stmt is skipped — raw WGSL may read a name this pass cannot see.

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir'
import { mapStmt } from './ir-transform'
import { bodyHasRaw, collectMutatedRoots } from './expr-utils'

/** Collect every `let name = <lit>` (recursively, incl. nested bodies) whose name
 *  is never mutated. Function-wide collection is safe — names are unique per fn. */
function collectConstLets(
  body: readonly Stmt[],
  mutated: ReadonlySet<string>,
  out: Map<string, Expr>,
): void {
  for (const s of body) {
    if (s.s === 'let' && s.expr.op === 'lit' && !mutated.has(s.name)) out.set(s.name, s.expr)
    else if (s.s === 'if') {
      for (const a of s.arms) collectConstLets(a.body, mutated, out)
      if (s.elseBody) collectConstLets(s.elseBody, mutated, out)
    } else if (s.s === 'for') {
      collectConstLets([s.init], mutated, out)
      collectConstLets(s.body, mutated, out)
    } else if (s.s === 'switch') {
      for (const c of s.cases) collectConstLets(c.body, mutated, out)
      if (s.defaultBody) collectConstLets(s.defaultBody, mutated, out)
    }
  }
}

function constPropFn(f: FuncDecl): FuncDecl {
  if (bodyHasRaw(f.body)) return f
  const mutated = new Set<string>()
  collectMutatedRoots(f.body, mutated)
  const consts = new Map<string, Expr>()
  collectConstLets(f.body, mutated, consts)
  if (consts.size === 0) return f
  const sub = (e: Expr): Expr => (e.op === 'varref' && consts.has(e.name) ? consts.get(e.name)! : e)
  return { ...f, body: f.body.map((s) => mapStmt(s, sub)) }
}

/** Propagate literal-bound, never-reassigned locals into their uses. Pure (module -> module). */
export function constProp(m: ModuleDecl): ModuleDecl {
  return { ...m, funcs: m.funcs.map(constPropFn) }
}
