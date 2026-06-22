import type { LintRule } from '../engine'

/** Duplicate function name in the module. */
export const dupFunc: LintRule = {
  id: 'dup-func',
  description: 'duplicate function name',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => ({
    Module(m) {
      const seen = new Set<string>()
      for (const f of m.funcs) {
        if (seen.has(f.name)) ctx.report(`duplicate function '${f.name}'`)
        seen.add(f.name)
      }
    },
  }),
}
