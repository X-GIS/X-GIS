import type { ShaderType } from '../../../ir'
import { typeKey } from '../../../ir'
import type { LintRule } from '../engine'

const SHIFT_OPS = new Set(['<<', '>>'])
function mixedScalar(a: ShaderType, b: ShaderType): boolean {
  if (a.kind !== 'scalar' || b.kind !== 'scalar') return false
  if (a.scalar === 'bool' || b.scalar === 'bool') return false
  return a.scalar !== b.scalar
}

/** No implicit int↔float (nor i32↔u32) binop — WGSL rejects it. Just an Expr handler:
 *  the engine's single walk visits every sub-expression, so no recursion is needed. */
export const mixedScalarRule: LintRule = {
  id: 'mixed-scalar',
  description: 'no implicit int/float (nor i32/u32) binop — WGSL rejects it',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => ({
    Expr(e, fn) {
      if (e.op === 'binop' && !SHIFT_OPS.has(e.bop) && mixedScalar(e.a.type, e.b.type)) {
        ctx.report(
          `mixed-scalar binop in fn '${fn.name}': ${typeKey(e.a.type)} ${e.bop} ${typeKey(e.b.type)} — WGSL has no implicit int/float conversion`,
          { fn: fn.name },
        )
      }
    },
  }),
}
