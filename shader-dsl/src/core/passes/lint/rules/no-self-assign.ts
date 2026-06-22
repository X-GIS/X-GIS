import type { LintRule } from '../engine'

/** Flag an assignment whose target and value are structurally identical (e.g. x = x) —
 *  a no-op that's almost always a typo. Compared structurally via JSON.stringify. */
export const noSelfAssign: LintRule = {
  id: 'no-self-assign',
  description: 'an assignment whose target and value are identical (e.g. x = x) is a likely typo',
  severity: 'warning',
  category: 'correctness',
  create: (ctx) => ({
    Stmt(s, fn) {
      if (s.s === 'assign' && JSON.stringify(s.target) === JSON.stringify(s.expr)) {
        ctx.report(`self-assignment in fn '${fn.name}' — target and value are identical (likely typo)`, { fn: fn.name })
      }
    },
  }),
}
