import type { ShaderType } from '../../../ir/index.js'
import { typeKey } from '../../../ir/index.js'
import type { LintRule } from '../engine.js'

const SHIFT_OPS = new Set(['<<', '>>'])
function mixedScalar(a: ShaderType, b: ShaderType): boolean {
  if (a.kind !== 'scalar' || b.kind !== 'scalar') return false
  if (a.scalar === 'bool' || b.scalar === 'bool') return false
  return a.scalar !== b.scalar
}

/** No implicit int↔float (nor i32↔u32) binop OR comparison — WGSL rejects both. Just an
 *  Expr handler: the engine's single walk visits every sub-expression, so no recursion
 *  is needed. Compares joined the rule late: a mixed COMPARE (`u32Count > 0.0`) had NO
 *  gate at all — the binop-only walk missed it, and it emitted code neither target
 *  compiles (caught in the wild by the override-constants example; the kind-matched
 *  CmpArg now rejects it at tsc, this arm is the raw-IR backstop). f64 operands are
 *  excluded structurally (their kind is 'f64', not 'scalar'): an f64∘f32 compare is
 *  the legal exact-widen, resolved by fp64Lower after this rule runs. */
export const mixedScalarRule: LintRule = {
  id: 'mixed-scalar',
  description: 'no implicit int/float (nor i32/u32) binop or comparison — WGSL rejects it',
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
      if (e.op === 'compare' && mixedScalar(e.a.type, e.b.type)) {
        ctx.report(
          `mixed-scalar compare in fn '${fn.name}': ${typeKey(e.a.type)} ${e.cop} ${typeKey(e.b.type)} — WGSL has no implicit int/float conversion`,
          { fn: fn.name },
        )
      }
    },
  }),
}
