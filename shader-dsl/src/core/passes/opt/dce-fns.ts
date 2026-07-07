// ═══ Shader DSL — dead-FUNCTION elimination (tree-shaking) pass ═══
//
// Drops module functions that are UNREACHABLE from the entry points. The
// local `dce` pass prunes dead bindings INSIDE a fn; this prunes whole fns no
// entry point can ever call (e.g. a helper left behind after dead-branch elim
// removed its only call site, or an over-broad shared prelude). Pure + safe:
// an uncallable function has no observable effect, so removing it is bit-exact
// (the oracle / GPU values are unchanged; only the emitted bytes shrink).
//
// Reachability:
//   • Roots = entry points — a fn with a non-empty `attrs` (`@vertex` /
//     `@fragment` / `@compute …`). Helpers have empty attrs.
//   • Edge = a `call` Expr whose `fn` names another MODULE function (builtins
//     like `i32` / `vec4` / `max` have no matching FuncDecl, so they're ignored).
//   • Keep every fn reachable from a root (transitively); drop the rest.
//
// Conservative bail-outs (match the local dce's leniency — never drop a fn that
// MIGHT be referenced by something the IR walker can't see):
//   • Any `raw` Stmt anywhere → a raw WGSL fragment can call a helper by name
//     textually, invisible to this walk → skip whole-module tree-shaking.
//   • No entry points → can't compute reachability (a helper-only func list,
//     e.g. the `emitFuncsCsed` parity-harness path) → no-op, keep everything.

import { stageOf } from '../../ir'
import type { ModuleDecl, FuncDecl } from '../../ir'
import { collectFnRefs } from '../../ir/collect-refs'
import { bodyHasRaw } from './dce'

// Roots = pipeline entries via the shared stage predicate (#763 S4) — the old
// `attrs.length > 0` missed structured-only entries and mistook any attr'd
// helper for a root.
const isEntry = (f: FuncDecl): boolean => stageOf(f) !== undefined

/** Remove functions unreachable from the module's entry points. Pure (module -> module). */
export function deadFnElim(m: ModuleDecl): ModuleDecl {
  // A raw WGSL stmt may textually call a helper this walk can't see → bail.
  if (m.funcs.some((f) => bodyHasRaw(f.body))) return m

  const roots = m.funcs.filter(isEntry)
  // Helper-only func list (no entry point) → reachability is undefined; keep all.
  if (roots.length === 0) return m

  const byName = new Map(m.funcs.map((f) => [f.name, f]))
  const reachable = new Set<string>(roots.map((f) => f.name))
  const stack: FuncDecl[] = [...roots]
  while (stack.length > 0) {
    const f = stack.pop()!
    // Shared walk (ir/collect-refs — the walk SoT); only `calls` matters here.
    const { calls } = collectFnRefs(f)
    for (const name of calls) {
      if (byName.has(name) && !reachable.has(name)) {
        reachable.add(name)
        stack.push(byName.get(name)!)
      }
    }
  }

  if (reachable.size === m.funcs.length) return m // nothing unreachable
  return { ...m, funcs: m.funcs.filter((f) => reachable.has(f.name)) }
}
