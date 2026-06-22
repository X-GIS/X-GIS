import type { Stmt } from '../../../ir'
import type { LintRule } from '../engine'

function countStmts(body: readonly Stmt[]): number {
  let n = 0
  for (const s of body) {
    n += 1
    if (s.s === 'if') {
      for (const a of s.arms) n += countStmts(a.body)
      if (s.elseBody) n += countStmts(s.elseBody)
    } else if (s.s === 'for') {
      n += countStmts(s.body)
    } else if (s.s === 'switch') {
      for (const c of s.cases) n += countStmts(c.body)
      if (s.defaultBody) n += countStmts(s.defaultBody)
    }
  }
  return n
}

/** A function body with more statements than options.max (default 60) is hard to follow. */
export const maxFunctionLength: LintRule = {
  id: 'max-function-length',
  description: 'a function with too many statements is hard to follow',
  severity: 'warning',
  category: 'style',
  create: (ctx) => ({
    Func(f) {
      const max = (ctx.options?.max as number) ?? 60
      const n = countStmts(f.body)
      if (n > max) ctx.report(`fn '${f.name}' has ${n} statements > ${max}`, { fn: f.name })
    },
  }),
}
