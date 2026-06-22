import type { Stmt } from '../../../ir'
import type { LintRule } from '../engine'

function decisionPoints(body: readonly Stmt[]): number {
  let n = 0
  for (const s of body) {
    if (s.s === 'if') {
      n += s.arms.length
      for (const a of s.arms) n += decisionPoints(a.body)
      if (s.elseBody) n += decisionPoints(s.elseBody)
    } else if (s.s === 'for') {
      n += 1 + decisionPoints(s.body)
    } else if (s.s === 'switch') {
      n += s.cases.length
      for (const c of s.cases) n += decisionPoints(c.body)
      if (s.defaultBody) n += decisionPoints(s.defaultBody)
    }
  }
  return n
}

/** Cyclomatic complexity (decision points + 1) over options.max (default 20). */
export const cyclomaticComplexity: LintRule = {
  id: 'cyclomatic-complexity',
  description: 'a function with too many branches is hard to verify',
  severity: 'warning',
  category: 'perf',
  create: (ctx) => ({
    Func(f) {
      const max = (ctx.options?.max as number) ?? 20
      const c = decisionPoints(f.body) + 1
      if (c > max) ctx.report(`fn '${f.name}' cyclomatic complexity ${c} > ${max}`, { fn: f.name })
    },
  }),
}
