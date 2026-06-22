import type { LintRule } from '../engine'

/** A function with an empty body is almost always a stub or an accidental no-op. */
export const noEmptyFunction: LintRule = {
  id: 'no-empty-function',
  description: 'a function with an empty body is almost always a stub or an accidental no-op',
  severity: 'warning',
  category: 'correctness',
  create: (ctx) => ({
    Func(f) {
      if (f.body.length === 0) ctx.report(`fn '${f.name}' has an empty body`, { fn: f.name })
    },
  }),
}
