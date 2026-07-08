// ═══ inlineLinearAll — single-return + LINEAR multi-statement inlining ═══
//
// emit-prod's inline() plugin. Single-return helpers inline by expression
// substitution (inlineFn); linear multi-statement helpers (let/var prelude + one
// trailing return, e.g. a value-noise fn) inline by lifting their statements
// into the caller. Value-equality is checked against the CPU oracle; the safety
// exclusions (control flow, for-header call sites, df64, entry, recursion) are
// asserted to leave the function untouched.

import { describe, it, expect } from 'vitest'
import {
  module,
  fn,
  callFn,
  f32,
  f32T,
  boolT,
  floor,
  fract,
  toF32,
  toF64,
  If,
  type ModuleDecl,
  type FuncDecl,
} from '../ir'
import { emitModule } from '../backends/wgsl'
import { emitGlslModule } from '../backends/glsl'
import { compileModule } from '../oracle'
import { inlineLinearAll } from './inline-linear'

// A linear multi-statement helper: two `let`s then a return (the noise shape).
const vnoise = fn('vnoise', { p: f32T }, f32T, ({ p }, b) => {
  const a = b.let('a', floor(p))
  const c = b.let('c', fract(p))
  b.ret(a.add(c).mul(2))
})
// A fragment entry that calls the linear helper (for the GLSL `__` check).
const vnoiseFrag = fn('vnoiseFrag', {}, f32T, (_a, b) => b.ret(callFn('vnoise', f32T, f32(0.5))), {
  stage: 'fragment',
  retAttr: '@location(0)',
})

describe('inlineLinearAll — linear multi-statement inlining', () => {
  it('inlines a linear helper at a single call site and drops it (value preserved)', () => {
    const m = module({
      funcs: [
        vnoise,
        fn('caller', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(callFn('vnoise', f32T, x).mul(3))
        }),
      ],
    })
    const out = inlineLinearAll(m)
    const wgsl = emitModule(out)
    expect(wgsl).not.toContain('fn vnoise')
    expect(wgsl).not.toMatch(/\bvnoise\(/)
    expect(compileModule(out).fns.caller(2.5) as number).toBeCloseTo(
      compileModule(m).fns.caller(2.5) as number,
      6,
    )
  })

  it('inlines a linear helper at MULTIPLE + nested call sites with unique temps', () => {
    const m = module({
      funcs: [
        vnoise,
        fn('caller', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(callFn('vnoise', f32T, x).add(callFn('vnoise', f32T, x.mul(2))))
        }),
      ],
    })
    const out = inlineLinearAll(m)
    const wgsl = emitModule(out)
    expect(wgsl).not.toContain('fn vnoise')
    // two independent inline instances → two distinct temp prefixes, no re-decl.
    expect(wgsl).toMatch(/_inl0_/)
    expect(wgsl).toMatch(/_inl1_/)
    expect(compileModule(out).fns.caller(1.3) as number).toBeCloseTo(
      compileModule(m).fns.caller(1.3) as number,
      6,
    )
  })

  it('spliced local names never form GLSL-reserved double underscores', () => {
    // The lift renames a helper local (the optimizer names them `_cse0`/`_v0`)
    // under an instance prefix; a naive join makes `__`, which GLSL ES rejects.
    // WGSL tolerates `__`, so this must be checked on the GLSL emit.
    const glsl = emitGlslModule(module({ funcs: [vnoise, vnoiseFrag] }), 'fragment', {
      plugins: [{ name: 'inline', transformIR: inlineLinearAll }],
    })
    expect(glsl).not.toContain('__')
    expect(glsl).not.toContain('vnoise(')
  })

  it('still inlines single-return helpers by plain substitution (no temps)', () => {
    const m = module({
      funcs: [
        fn('sq', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.mul(x))
        }),
        fn('caller', { y: f32T }, f32T, ({ y }, b) => {
          b.ret(callFn('sq', f32T, y).add(callFn('sq', f32T, y)))
        }),
      ],
    })
    const wgsl = emitModule(inlineLinearAll(m))
    expect(wgsl).not.toContain('fn sq')
    expect(wgsl).not.toMatch(/_inl\d+_/) // single-return path introduces no lift temps
  })

  it('is deterministic — identical bytes across runs (GLSL two-stage link needs it)', () => {
    const m = module({
      funcs: [
        vnoise,
        fn('caller', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(callFn('vnoise', f32T, x).add(callFn('vnoise', f32T, x.add(1))))
        }),
      ],
    })
    expect(emitModule(inlineLinearAll(m))).toBe(emitModule(inlineLinearAll(m)))
  })
})

describe('inlineLinearAll — conservative exclusions', () => {
  it('leaves a control-flow (if) helper intact', () => {
    const m = module({
      funcs: [
        fn('branchy', { x: f32T }, f32T, ({ x }, b) => {
          const r = b.var('r', f32T, f32(0))
          If(x.gt(0), () => {
            r.assign(x)
          }).else(() => {
            r.assign(x.neg())
          })
          b.ret(r)
        }),
        fn('caller', { y: f32T }, f32T, ({ y }, b) => {
          b.ret(callFn('branchy', f32T, y))
        }),
      ],
    })
    expect(emitModule(inlineLinearAll(m))).toContain('fn branchy')
  })

  it('leaves a helper called in a for-header intact (unsound to lift)', () => {
    // Hand-built: `for (var i=0.0; i < vnoise(x); i=i+1) { acc = i }` — the call
    // sits in the loop condition, so lifting it out would change how often it runs.
    const forMod: ModuleDecl = {
      consts: [],
      structs: [],
      bindings: [],
      funcs: [
        vnoise as FuncDecl,
        {
          name: 'caller',
          params: [{ name: 'x', type: f32T }],
          ret: f32T,
          body: [
            { s: 'var', name: 'acc', type: f32T, init: { op: 'lit', type: f32T, value: 0 } },
            {
              s: 'for',
              init: { s: 'var', name: 'i', type: f32T, init: { op: 'lit', type: f32T, value: 0 } },
              cond: {
                op: 'compare',
                cop: '<',
                type: boolT,
                a: { op: 'varref', type: f32T, name: 'i' },
                b: {
                  op: 'call',
                  fn: 'vnoise',
                  type: f32T,
                  args: [{ op: 'varref', type: f32T, name: 'x' }],
                },
              },
              update: {
                s: 'assign',
                target: { op: 'varref', type: f32T, name: 'i' },
                expr: {
                  op: 'binop',
                  bop: '+',
                  type: f32T,
                  a: { op: 'varref', type: f32T, name: 'i' },
                  b: { op: 'lit', type: f32T, value: 1 },
                },
              },
              body: [
                {
                  s: 'assign',
                  target: { op: 'varref', type: f32T, name: 'acc' },
                  expr: { op: 'varref', type: f32T, name: 'i' },
                },
              ],
            },
            { s: 'return', expr: { op: 'varref', type: f32T, name: 'acc' } },
          ],
        },
      ],
    }
    expect(emitModule(inlineLinearAll(forMod))).toContain('fn vnoise')
  })

  it('never inlines the df64 emulation library (opacity invariant holds)', () => {
    const mf = module({
      funcs: [
        fn('kf', { a: f32T }, f32T, ({ a }, b) => {
          b.ret(toF32(toF64(a).add(toF64(a))))
        }),
      ],
    })
    const wgsl = emitModule(mf, { plugins: [{ name: 'inline', transformIR: inlineLinearAll }] })
    expect(wgsl).toContain('df64_add(')
    expect(wgsl).toContain('fn df64_add')
    expect(wgsl).toContain('fn df64_twoSum')
  })
})
