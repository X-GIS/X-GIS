import type { LintRule } from '../engine'

/** WGSL has no call stack — a function must not (directly) call itself. */
export const noRecursion: LintRule = {
  id: 'no-recursion',
  description: 'WGSL forbids recursion — a function must not call itself',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => ({
    Expr(e, fn) {
      if (e.op === 'call' && e.fn === fn.name) {
        ctx.report(`fn '${fn.name}' calls itself — WGSL has no recursion`, { fn: fn.name })
      }
    },
  }),
}
