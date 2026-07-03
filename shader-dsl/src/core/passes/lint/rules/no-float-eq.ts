import type { ShaderType } from '../../../ir'
import type { LintRule } from '../engine'

const isFloat = (t: ShaderType): boolean => t.kind === 'scalar' && t.scalar === 'f32'

/** Exact == / != on f32 is rounding-unreliable; compare within an epsilon instead. */
export const noFloatEq: LintRule = {
  id: 'no-float-eq',
  description: 'exact == / != on f32 is unreliable — compare within an epsilon',
  severity: 'warning',
  category: 'correctness',
  create: (ctx) => ({
    Expr(e, fn) {
      if (
        e.op === 'compare' &&
        (e.cop === '==' || e.cop === '!=') &&
        (isFloat(e.a.type) || isFloat(e.b.type))
      ) {
        ctx.report(`f32 '${e.cop}' in fn '${fn.name}' — exact float equality is unreliable`, {
          fn: fn.name,
        })
      }
    },
  }),
}
