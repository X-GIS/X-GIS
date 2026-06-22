import type { LintRule } from '../engine'

/** Duplicate struct name in the module. */
export const dupStruct: LintRule = {
  id: 'dup-struct',
  description: 'duplicate struct name',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => ({
    Module(m) {
      const seen = new Set<string>()
      for (const s of m.structs) {
        if (seen.has(s.name)) ctx.report(`duplicate struct '${s.name}'`)
        seen.add(s.name)
      }
    },
  }),
}
