import { describe, expect, it } from 'vitest'
import { module, fn, f32, f32T, i32, vec3fT, vec3, normalize, Var } from '../../ir/index.js'
import { emitModule } from '../../backends/wgsl.js'
import { compileModule } from '../../oracle.js'
import { cseLocal } from './cse-local.js'

// cse-local hoists a subexpr that repeats WITHIN ONE statement and touches a local/var —
// the redundancy the fn-top `cse` (input-only, fn-top placement) cannot reach.

// A var read 3× through normalize() inside a single `return`: `v` is mutated, so fn-top
// cse skips it; without cse-local the normalize (a sqrt + 3 divides) emits 3×.
const repeatModule = () =>
  module({
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

// ═══ Control-flow CONDITIONS (#1886) ═══
//
// The same blind spot gvn had: `valueExprs` returned [] for control flow, so a repeat
// INSIDE an `if` condition was never hoisted. Measured on the 87-source baked corpus
// after gvn's fix, the contrast is the whole argument — 119 within-statement repeats
// remain inside control-flow headers against 4 inside plain statements, i.e. this pass
// works wherever it can see and the leftovers are almost entirely where it cannot.
// `glsl-boot-4cc70deab1.glsl:365` is the witness: an `if` condition evaluating
// `-sign(_v11)` twice, whose own body already holds `float _gv16 = (-sign(_v11));`.
//
// HOW THE TWO EXCLUSION ARMS BELOW WERE VERIFIED, because the obvious cut is INERT:
// widening `valueExprs` alone changes nothing observable — the temp is minted, nothing
// references it because `mapStmtValue` still rewrites arm 0 only, and `dce` deletes it
// again. Both arms passed under that cut and would have shipped proving nothing. The
// cut that distinguishes is the mistake a person would actually make: widen `valueExprs`
// AND `mapStmtValue` together. Then the `else if` arm and the `for` arm each red.
describe('cse-local — control-flow conditions (#1886)', () => {
  it('collapses a repeat inside an `if` condition', () => {
    const m = module({
      funcs: [
        fn('c', { x: f32T }, f32T, ({ x }, b) => {
          const v = Var(vec3(x, x, x))
          v.assign(v.add(vec3(1, 1, 1))) // a var → fn-top cse cannot reach it
          const r = Var(f32(0))
          // normalize(v) twice in ONE condition, both unconditionally evaluated.
          b.if(normalize(v).x.gt(normalize(v).y), () => {
            r.assign(f32(1))
          })
          b.ret(r)
        }),
      ],
    })
    const wgsl = emitModule(cseLocal(m))
    const fbody = wgsl.slice(wgsl.indexOf('fn c('))
    const calls = (fbody.match(/normalize\(/g) ?? []).length
    expect(calls, `normalize should emit once, got ${calls}:\n${fbody}`).toBe(1)
    const before = compileModule(m).fns.c!
    const after = compileModule(cseLocal(m)).fns.c!
    for (const x of [1, 2, -3, 0.25]) expect(after(x), `x=${x}`).toEqual(before(x))
  })

  it('does NOT hoist out of an `else if` condition', () => {
    // Guarded by the arm before it — a temp placed before the `if` would run on the
    // x > 0 path, where the authored code never evaluates it.
    const m = module({
      funcs: [
        fn('e', { x: f32T }, f32T, ({ x }, b) => {
          const v = Var(vec3(x, x, x))
          v.assign(v.add(vec3(1, 1, 1)))
          const r = Var(f32(0))
          b.if(x.gt(0), () => {
            r.assign(f32(1))
          }).elif(normalize(v).x.gt(normalize(v).y), () => {
            r.assign(f32(2))
          })
          b.ret(r)
        }),
      ],
    })
    expect(emitModule(cseLocal(m))).not.toMatch(/_lc\d+ = normalize/)
  })

  it('does NOT hoist out of a `for` condition', () => {
    // Re-evaluated per iteration; lifting it is loop invariance, which is licm's job.
    // The repeat is on the LEFT of the `&&` on purpose — on the right the short-circuit
    // guard would exclude it whatever `valueExprs` returns, and this arm would pass
    // with `for` conditions tallied, proving nothing.
    const m = module({
      funcs: [
        fn('l', { x: f32T }, f32T, ({ x }, b) => {
          const v = Var(vec3(x, x, x))
          v.assign(v.add(vec3(1, 1, 1)))
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            i32(0),
            (i) =>
              normalize(v)
                .x.gt(normalize(v).y.sub(9))
                .and(i.lt(i32(2))),
            (cb) => {
              cb.addAssign(acc, f32(1))
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(emitModule(cseLocal(m))).not.toMatch(/_lc\d+ = normalize/)
  })
})
