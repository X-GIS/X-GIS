import type { LintRule } from '../engine'

const SNAKE = /^[a-z][a-z0-9_]*$/
const PASCAL = /^[A-Z][A-Za-z0-9]*$/

/** WGSL house style: function names snake_case, struct names PascalCase. One rule, two
 *  handlers — the engine invokes whichever a rule implements. */
export const namingConvention: LintRule = {
  id: 'naming-convention',
  description: 'function names snake_case, struct names PascalCase',
  severity: 'warning',
  category: 'style',
  create: (ctx) => ({
    Module(m) {
      for (const s of m.structs) {
        if (!PASCAL.test(s.name)) ctx.report(`struct '${s.name}' should be PascalCase`)
      }
    },
    Func(f) {
      if (!SNAKE.test(f.name)) ctx.report(`fn '${f.name}' should be snake_case`, { fn: f.name })
    },
  }),
}
