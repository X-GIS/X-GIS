import { mapStmts, type LintRule } from '../engine'

const isSelfAssign = (s: { s: string; target?: unknown; expr?: unknown }): boolean =>
  s.s === 'assign' && JSON.stringify(s.target) === JSON.stringify(s.expr)

/** Flag an assignment whose target and value are structurally identical (e.g. x = x) —
 *  a no-op that's almost always a typo. Compared structurally via JSON.stringify. */
export const noSelfAssign: LintRule = {
  id: 'no-self-assign',
  description: 'an assignment whose target and value are identical (e.g. x = x) is a likely typo',
  severity: 'warning',
  category: 'correctness',
  create: (ctx) => ({
    Stmt(s, fn) {
      if (isSelfAssign(s)) {
        ctx.report(
          `self-assignment in fn '${fn.name}' — target and value are identical (likely typo)`,
          { fn: fn.name },
        )
      }
    },
  }),
  // auto-fix: delete the no-op self-assignment.
  fix(m) {
    let changed = false
    const funcs = m.funcs.map((f) => ({
      ...f,
      body: mapStmts(f.body, (s) => {
        if (isSelfAssign(s)) {
          changed = true
          return null
        }
        return s
      }),
    }))
    return changed ? { ...m, funcs } : null
  },
}
