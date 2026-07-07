import type { Expr } from '../../../ir'
import type { LintRule } from '../engine'

const litOf = (e: Expr): number | undefined =>
  e.op === 'lit' && typeof e.value === 'number' ? e.value : undefined

/** GLSL ES leaves `smoothstep` UNDEFINED when edge0 >= edge1 — most drivers
 *  happen to return the mirrored ramp, so reversed edges "work" locally and
 *  break on another GPU (#841). When both edges are literals the order is
 *  statically decidable; the house form for a descending ramp is
 *  `1 − smoothstep(lo, hi, x)`. */
export const smoothstepEdgeOrder: LintRule = {
  id: 'smoothstep-edge-order',
  description: 'smoothstep with constant edge0 >= edge1 is undefined in GLSL ES',
  severity: 'warning',
  category: 'correctness',
  create: (ctx) => ({
    Expr(e, fn) {
      if (e.op !== 'call' || e.fn !== 'smoothstep' || e.args.length !== 3) return
      const e0 = litOf(e.args[0]!)
      const e1 = litOf(e.args[1]!)
      if (e0 !== undefined && e1 !== undefined && e0 >= e1) {
        ctx.report(
          `smoothstep(${e0}, ${e1}, …) in fn '${fn.name}' — edge0 >= edge1 is undefined in GLSL ES`,
          {
            fn: fn.name,
            node: e,
            code: 'SD0108',
            hint: 'write 1 − smoothstep(lo, hi, x) instead of reversing the edges',
          },
        )
      }
    },
  }),
}
