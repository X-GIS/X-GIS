import type { Stmt } from '../../../ir'
import type { LintRule } from '../engine'

function nestingDepth(body: readonly Stmt[], cur: number): number {
  let d = cur
  for (const s of body) {
    if (s.s === 'if') {
      for (const a of s.arms) d = Math.max(d, nestingDepth(a.body, cur + 1))
      if (s.elseBody) d = Math.max(d, nestingDepth(s.elseBody, cur + 1))
    } else if (s.s === 'for') {
      d = Math.max(d, nestingDepth(s.body, cur + 1))
    } else if (s.s === 'switch') {
      for (const c of s.cases) d = Math.max(d, nestingDepth(c.body, cur + 1))
      if (s.defaultBody) d = Math.max(d, nestingDepth(s.defaultBody, cur + 1))
    }
  }
  return d
}

/** Control flow nested deeper than options.max (default 5). */
export const maxNesting: LintRule = {
  id: 'max-nesting-depth',
  description: 'control flow nested too deeply',
  severity: 'warning',
  category: 'perf',
  create: (ctx) => ({
    Func(f) {
      const max = (ctx.options?.max as number) ?? 5
      const d = nestingDepth(f.body, 0)
      if (d > max) ctx.report(`fn '${f.name}' nesting depth ${d} > ${max}`, { fn: f.name })
    },
  }),
}
