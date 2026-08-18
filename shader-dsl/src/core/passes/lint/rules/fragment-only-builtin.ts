import type { LintRule } from '../engine.js'
import { stageOf } from '../../../ir/index.js'
import { collectFnRefs, emptyRefSet } from '../../../ir/collect-refs.js'

/** The derivative builtins (#1654) share ONE fix: unlike the texture rows there is
 *  no drop-in same-shape alternative — a screen-space derivative simply does not
 *  exist outside a fragment invocation, so the quantity has to come from elsewhere. */
const DERIVATIVE_FIX =
  'precompute the quantity and pass it in (a per-vertex varying, a CPU-computed uniform, or finite differences of neighboring samples) — derivatives exist only in a fragment invocation'

/** Fragment-only builtin id -> the fix its message must name. Table-driven, so a
 *  further fragment-only builtin joins by adding ONE row.
 *
 *  THIS TABLE IS THE SINGLE FIX-AUTHORITY (#1654). It now holds three fix families —
 *  the explicit-LOD texture form, its array form (whose fix must name the layer
 *  argument), and the derivatives (no same-shape alternative exists at all) — so the
 *  SD0109 catalogue hint (codes.ts) is deliberately GENERIC and points the reader at
 *  the diagnostic's own message; it is NOT a copy of any row. That replaces #1650's
 *  "first row byte-identical to the catalogue hint / one string, two surfaces"
 *  convention, which nothing ever enforced (no test compared the two) and which
 *  #1651's array row had already broken. Per-id hints are pinned where they are
 *  authored: this rule's tests. */
const FRAGMENT_ONLY_IDS: ReadonlyMap<string, string> = new Map([
  [
    'textureSample',
    'use textureSampleLevel(tex, smp, uv, level) — an explicit LOD needs no derivatives',
  ],
  [
    'textureSampleArray',
    'use textureSampleLevel(tex, smp, uv, layer, level) — an explicit LOD needs no derivatives',
  ],
  ['dpdx', DERIVATIVE_FIX],
  ['dpdy', DERIVATIVE_FIX],
  ['fwidth', DERIVATIVE_FIX],
])

/** A fragment-only builtin must not be reachable from a VERTEX or COMPUTE entry.
 *
 *  `textureSample` derives its mip level from screen-space derivatives, which exist
 *  only in a fragment invocation — WGSL therefore rejects it in any other stage, and
 *  the failure surfaces as an opaque naga/driver error far from the call site. The
 *  derivative builtins themselves (`dpdx` / `dpdy` / `fwidth`, #1654) are fragment-only
 *  for the same reason.
 *
 *  Reachability is the call-graph closure from each non-fragment entry over the
 *  module's own fns (collectFnRefs — the collector stageScope also uses), so a builtin
 *  buried two helpers deep is caught too. A helper reachable only from a fragment
 *  entry is fine; one reachable from BOTH is flagged, because it is emitted into the
 *  vertex/compute stage as well (pinned by a dual-entry test, #1654). A module with no
 *  non-fragment entry (helper-only / runtime-composed) is silent by construction.
 *
 *  `raw` Stmts: collectFnRefs cannot see a call made inside raw WGSL text (its
 *  documented contract), so a raw-only edge makes this rule UNDER-report — never
 *  mis-report: IR edges are real calls, so every flagged violation is true whatever
 *  raw contains. Deliberately NOT bailed on raw, unlike dce-fns / stageScope: those
 *  TRANSFORM the module and need the complete graph to act safely; a diagnostic only
 *  needs its positives sound, and bailing would silence true catches in any module
 *  that merely carries an unrelated raw Stmt. Both behaviors are pinned by tests. */
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
