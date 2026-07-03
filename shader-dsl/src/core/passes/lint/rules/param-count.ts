import type { LintRule } from '../engine'

/** A function with too many parameters is hard to call correctly. options.max (default 6). */
export const paramCount: LintRule = {
  id: 'param-count',
  description: 'a function with too many parameters is hard to call correctly',
  severity: 'warning',
  category: 'style',
  create: (ctx) => ({
    Func(f) {
      const max = (ctx.options?.max as number) ?? 6
      if (f.params.length > max)
        ctx.report(`fn '${f.name}' has ${f.params.length} parameters > ${max}`, { fn: f.name })
    },
  }),
}
