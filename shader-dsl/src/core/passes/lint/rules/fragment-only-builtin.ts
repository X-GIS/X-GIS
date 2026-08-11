import type { LintRule } from '../engine'
import { stageOf } from '../../../ir'
import { collectFnRefs, emptyRefSet } from '../../../ir/collect-refs'

/** Fragment-only builtin id -> the fix its message must name. Table-driven so a
 *  further derivative builtin (dpdx / dpdy / fwidth — also fragment-only in WGSL)
 *  joins by adding ONE row; deliberately not added here (#1650 scope). */
const FRAGMENT_ONLY_IDS: ReadonlyMap<string, string> = new Map([
  ['textureSample', 'use textureSampleLevel(tex, smp, uv, level)'],
])

/** A fragment-only builtin must not be reachable from a VERTEX or COMPUTE entry.
 *
 *  `textureSample` derives its mip level from screen-space derivatives, which exist
 *  only in a fragment invocation — WGSL therefore rejects it in any other stage, and
 *  the failure surfaces as an opaque naga/driver error far from the call site.
 *
 *  Reachability is the call-graph closure from each non-fragment entry over the
 *  module's own fns (the same walk the GLSL backend's stageScope uses), so a builtin
 *  buried two helpers deep is caught too. A helper reachable only from a fragment
 *  entry is fine; one reachable from BOTH is flagged, because it is emitted into the
 *  vertex/compute stage as well. A module with no non-fragment entry (helper-only /
 *  runtime-composed) is silent by construction. */
export const fragmentOnlyBuiltin: LintRule = {
  id: 'fragment-only-builtin',
  description: 'a fragment-only builtin must not be reachable from a vertex or compute entry',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => {
    const byName = new Map(ctx.module.funcs.map((f) => [f.name, f]))
    const entries = ctx.module.funcs.filter((f) => {
      const stage = stageOf(f)
      return stage === 'vertex' || stage === 'compute'
    })
    // Call-graph closure from the non-fragment entries.
    const reachable = new Set(entries.map((f) => f.name))
    const stack = [...entries]
    while (stack.length > 0) {
      const refs = emptyRefSet()
      collectFnRefs(stack.pop()!, refs)
      for (const name of refs.calls) {
        const f = byName.get(name)
        if (f && !reachable.has(name)) {
          reachable.add(name)
          stack.push(f)
        }
      }
    }
    return {
      Expr(e, fn) {
        if (e.op !== 'call' || !reachable.has(fn.name)) return
        const fix = FRAGMENT_ONLY_IDS.get(e.fn)
        if (fix === undefined) return
        ctx.report(`${e.fn} is fragment-only in WGSL — ${fix}`, {
          fn: fn.name,
          node: e,
          code: 'SD0109',
          hint: fix,
        })
      },
    }
  },
}
