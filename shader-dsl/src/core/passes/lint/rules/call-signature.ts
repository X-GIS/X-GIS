import type { LintRule } from '../engine'
import { typeEq, typeKey } from '../../../ir'

/** A call to a MODULE fn must match its declared parameter count and types.
 *
 *  Closes the hole left by FnHandle's loose positional call form
 *  (`(...args: NodeLike[])` — no arity, no types, no order at the TS level):
 *  a swapped or missing argument that TS cannot see fails HERE at emit time,
 *  with the fn and parameter named, instead of as an opaque driver error or a
 *  silently wrong render.
 *
 *  Scope charter (same as validate.ts's name-resolution note): only calls whose
 *  name RESOLVES to a fn in this module are checked. An unresolvable name is an
 *  intrinsic or a composer-injected extern — skipped, so runtime-composed
 *  variants can never false-flag. Same-type swaps (lon/lat both f32) remain
 *  invisible to this rule; the typed object-param call form is the fix for those. */
export const callSignature: LintRule = {
  id: 'call-signature',
  description: 'a call to a module fn must match its declared parameter count and types',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => {
    const fns = new Map(ctx.module.funcs.map((f) => [f.name, f]))
    return {
      Expr(e, fn) {
        if (e.op !== 'call') return
        const target = fns.get(e.fn)
        if (!target) return // intrinsic / injected extern — name resolution is deferred by charter
        if (e.args.length !== target.params.length) {
          ctx.report(
            `call to '${e.fn}' passes ${e.args.length} argument${e.args.length === 1 ? '' : 's'}, declared ${target.params.length}`,
            {
              fn: fn.name,
              node: e,
              hint: `declared: ${target.params.map((p) => `${p.name}: ${typeKey(p.type)}`).join(', ')}`,
            },
          )
          return
        }
        e.args.forEach((a, i) => {
          const p = target.params[i]!
          if (!typeEq(a.type, p.type)) {
            ctx.report(
              `call to '${e.fn}' argument #${i + 1} ('${p.name}') is ${typeKey(a.type)}, declared ${typeKey(p.type)}`,
              { fn: fn.name, node: e },
            )
          }
        })
      },
    }
  },
}
