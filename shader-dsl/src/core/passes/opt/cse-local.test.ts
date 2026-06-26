import { describe, expect, it } from 'vitest'
import { module, fn, f32, f32T, vec3fT, vec3, normalize, Var } from '../../ir'
import { emitModule } from '../../backends/wgsl'
import { compileModule } from '../../oracle'
import { cseLocal } from './cse-local'

// cse-local hoists a subexpr that repeats WITHIN ONE statement and touches a local/var —
// the redundancy the fn-top `cse` (input-only, fn-top placement) cannot reach.

// A var read 3× through normalize() inside a single `return`: `v` is mutated, so fn-top
// cse skips it; without cse-local the normalize (a sqrt + 3 divides) emits 3×.
const repeatModule = () => module({
  funcs: [
    fn('f', { x: f32T }, vec3fT, ({ x }, b) => {
      const v = Var(vec3(x, x.mul(2), x.mul(3)))
      v.assign(v.add(vec3(1, 1, 1))) // mutate → v is a var, not hoistable by fn-top cse
      const n = normalize(v)
      b.ret(vec3(n.x, n.y, n.z)) // 3× normalize(v) in one statement
    }),
  ],
})

describe('cse-local — statement-local CSE', () => {
  it('collapses a var-touching repeat within one statement to a single temp', () => {
    const wgsl = emitModule(repeatModule())
    const body = wgsl.slice(wgsl.indexOf('fn f('))
    const calls = (body.match(/normalize\(/g) ?? []).length
    expect(calls, `normalize should emit once, got ${calls}:\n${body}`).toBe(1)
    expect(body).toContain('_lc0') // the hoisted statement-local temp
  })

  it('preserves oracle values (bit-equal before/after the pass)', () => {
    const m = repeatModule()
    const before = compileModule(m).fns.f
    const after = compileModule(cseLocal(m)).fns.f
    for (const x of [1, 2, 3.5, -4, 0.25]) {
      expect(after(x), `x=${x}`).toEqual(before(x))
    }
  })

  it('does NOT lift a repeat out of a short-circuit (||/&&) RHS', () => {
    // normalize(v) repeats only inside the short-circuited RHS of `||` — hoisting it
    // before the statement would evaluate it even when the LHS already decided the OR.
    const m = module({
      funcs: [
        fn('g', { x: f32T }, f32T, ({ x }, b) => {
          const v = Var(vec3(x, x, x))
          v.assign(v.add(vec3(1, 1, 1)))
          const cond = x.gt(0).or(normalize(v).x.gt(0.5).and(normalize(v).x.lt(0.9)))
          b.ret(cond.select(f32(1), f32(0)))
        }),
      ],
    })
    expect(emitModule(m)).not.toMatch(/_lc\d+ = normalize/)
  })
})
