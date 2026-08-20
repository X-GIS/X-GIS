// ═══ Shader DSL — stage REACHABILITY (which entries reach which bindings) ═══
//
// One fact, two consumers. The GLSL backend needs it because it compiles ONE stage per
// call and must not leak fragment-only machinery into the vertex unit (`stageScope` in
// backends/glsl.ts). A HOST needs the same fact because `GPUBindGroupLayoutEntry.visibility`
// is a required stage mask and a WebGL2 host assigns UBO points / texture units per stage
// — `reflect()` publishes it as `BindEntry.stages` (#1906).
//
// Before this the walk lived only inside the backend, so every host re-declared visibility
// by hand next to the binding (the reported cost: 32 hand-written `visibility:` sites in one
// consumer, each restating something the module already determines). A hand-authored mask
// that is wrong does not fail — it produces a silently wrong layout — which is exactly why
// this must not become a second, private copy of stage propagation.
//
// Read-only over the IR; imports no backend (reflect() is target-neutral, and glsl.ts
// already imports reflect's layout engine, so the dependency could only go this way).

import type { ModuleDecl, FuncDecl } from '../ir/index.js'
import { stageOf } from '../ir/index.js'
import { collectFnRefs, emptyRefSet, type RefSet } from '../ir/collect-refs.js'
import { INTRINSIC_BINDING_REFS } from '../intrinsics.js'
import { bodyHasRaw } from './opt/dce.js'

/** A pipeline stage — the three `stageOf` classifies an entry into. */
export type Stage = 'vertex' | 'fragment' | 'compute'

/** In the order `BindEntry.stages` reports them, so the list is deterministic. */
const STAGES: readonly Stage[] = ['vertex', 'fragment', 'compute']

/** What a set of entry points transitively reaches:
 *   • `fns`      — the call-graph closure from `entries` (the entries themselves included)
 *   • `bindings` — binding names varref'd by a reachable fn (a binding reference IS a
 *                  varref — ir/node.ts `bindingRef`; a same-named LOCAL only over-keeps),
 *                  plus the ones a called intrinsic's SPELLING names textually
 *                  (INTRINSIC_BINDING_REFS — `f64Guard`'s zero-arg fetch from `_fp64`,
 *                  which the IR walk has no argument node to see)
 *   • `refs`     — the raw reference set, for a caller that also needs the struct names
 */
export interface EntryReach {
  readonly fns: Set<string>
  readonly bindings: Set<string>
  readonly refs: RefSet
}

/** Walk the call graph from `entries` and collect what they reach. Pure. */
export function reachFrom(m: ModuleDecl, entries: readonly FuncDecl[]): EntryReach {
  const byName = new Map(m.funcs.map((f) => [f.name, f]))
  const refs = emptyRefSet()
  const fns = new Set(entries.map((f) => f.name))
  const stack = [...entries]
  while (stack.length > 0) {
    collectFnRefs(stack.pop()!, refs)
    for (const name of refs.calls) {
      const f = byName.get(name)
      if (f && !fns.has(name)) {
        fns.add(name)
        stack.push(f)
      }
    }
  }

  const bindings = new Set<string>()
  for (const b of m.bindings) if (refs.vars.has(b.name)) bindings.add(b.name)
  for (const call of refs.calls)
    for (const bound of INTRINSIC_BINDING_REFS[call] ?? []) bindings.add(bound)

  return { fns, bindings, refs }
}

/** Which stages reference each of the module's bindings, keyed by binding NAME. Every
 *  declared binding gets a row; the list is empty for one no entry reaches (a binding
 *  declared and never read, or a module with no entry at all) and is ordered
 *  vertex → fragment → compute.
 *
 *  A `raw` stmt anywhere in the module makes the walk UNSOUND — its text can name a
 *  binding no `Expr` mentions — so this reports the conservative superset (every stage
 *  that has an entry) for every binding, which is exactly what the per-stage GLSL emit
 *  does in that case: `stageScope` returns null and the stage declares everything. The
 *  two must agree, or a host builds a mask narrower than the shader it will run. */
export function bindingStages(m: ModuleDecl): ReadonlyMap<string, readonly Stage[]> {
  const out = new Map<string, Stage[]>(m.bindings.map((b) => [b.name, []]))
  const opaque = m.funcs.some((f) => bodyHasRaw(f.body))
  for (const stage of STAGES) {
    const entries = m.funcs.filter((f) => stageOf(f) === stage)
    if (entries.length === 0) continue
    const reached = opaque ? new Set(m.bindings.map((b) => b.name)) : reachFrom(m, entries).bindings
    for (const name of reached) out.get(name)?.push(stage)
  }
  return out
}
