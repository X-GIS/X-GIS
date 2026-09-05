import { describe, it, expect } from 'vitest'
import type { Expr, ModuleDecl } from '../ir/index.js'
import { f32T, vec2fT, i32T } from '../ir/index.js'
import { compileModule } from '../oracle.js'
import { compileModuleJs } from '../cpu-codegen.js'
import { froundF32 } from './precision.js'

// #2426 — the f32 oracle mode. The default oracle is f64 BY DESIGN (it is the algebra
// reference); this pass makes the same IR evaluate as a correctly-rounding f32 machine, so a
// parity gate can compare at ulp scale instead of a tolerance wide enough to hide a real error.

/** 0.1 + 0.2 is the classic case: f64 gives 0.30000000000000004, f32 gives 0.30000001192... */
const addModule: ModuleDecl = {
  consts: [],
  structs: [],
  bindings: [],
  funcs: [
    {
      name: 'k',
      params: [{ name: 'a', type: f32T }],
      ret: f32T,
      attrs: [],
      body: [
        {
          s: 'return',
          expr: {
            op: 'binop',
            type: f32T,
            bop: '+',
            a: { op: 'param', type: f32T, name: 'a' },
            b: { op: 'lit', type: f32T, value: 0.2 },
          },
        },
      ],
    },
  ],
}

describe('froundF32 — the f32 oracle mode', () => {
  it('rounds after every f32 operation, where f64 does not', () => {
    const f64 = compileModule(addModule).fns.k!(0.1)
    const f32 = compileModule(addModule, { precision: 'f32' }).fns.k!(0.1)
    expect(f64).toBe(0.1 + 0.2) // 0.30000000000000004 — the f64 answer, unchanged
    expect(f32).toBe(Math.fround(Math.fround(0.1) + Math.fround(0.2)))
    expect(f32).not.toBe(f64)
  })

  it('rounds the PARAMETER and the LITERAL too, which the wrappers it replaces did not', () => {
    // 16777217 is the first integer f32 cannot represent; it must arrive rounded, not merely
    // be rounded after the addition.
    const m: ModuleDecl = {
      ...addModule,
      funcs: [
        {
          ...addModule.funcs[0]!,
          body: [{ s: 'return', expr: { op: 'param', type: f32T, name: 'a' } }],
        },
      ],
    }
    expect(compileModule(m).fns.k!(16777217)).toBe(16777217)
    expect(compileModule(m, { precision: 'f32' }).fns.k!(16777217)).toBe(16777216)

    const litOnly: ModuleDecl = {
      ...addModule,
      funcs: [
        {
          ...addModule.funcs[0]!,
          body: [{ s: 'return', expr: { op: 'lit', type: f32T, value: 0.1 } }],
        },
      ],
    }
    expect(compileModule(litOnly).fns.k!(0)).toBe(0.1)
    expect(compileModule(litOnly, { precision: 'f32' }).fns.k!(0)).toBe(Math.fround(0.1))
  })

  it('overflows to Infinity as f32 does', () => {
    const m: ModuleDecl = {
      ...addModule,
      funcs: [
        {
          ...addModule.funcs[0]!,
          body: [
            {
              s: 'return',
              expr: {
                op: 'binop',
                type: f32T,
                bop: '*',
                a: { op: 'param', type: f32T, name: 'a' },
                b: { op: 'lit', type: f32T, value: 1e30 },
              },
            },
          ],
        },
      ],
    }
    // f64 has the range for 1e30 * 1e30 (the exact double is 1.0000000000000001e+60, which is
    // why this asserts finiteness rather than a literal); f32 tops out at ~3.4e38.
    expect(Number.isFinite(compileModule(m).fns.k!(1e30) as number)).toBe(true)
    expect(compileModule(m, { precision: 'f32' }).fns.k!(1e30)).toBe(Infinity)
  })

  it('leaves an ASSIGNMENT TARGET alone — the trap the naive rule falls into', () => {
    // `mapStmt` rewrites targets as well as values, so wrapping every f32 expr would emit
    // `__fround(x) = …`. A var written then read must still round its stored value.
    const m: ModuleDecl = {
      consts: [],
      structs: [],
      bindings: [],
      funcs: [
        {
          name: 'k',
          params: [{ name: 'a', type: f32T }],
          ret: f32T,
          attrs: [],
          body: [
            { s: 'var', name: 'acc', type: f32T, init: { op: 'lit', type: f32T, value: 0 } },
            {
              s: 'assign',
              target: { op: 'varref', type: f32T, name: 'acc' },
              expr: {
                op: 'binop',
                type: f32T,
                bop: '+',
                a: { op: 'param', type: f32T, name: 'a' },
                b: { op: 'lit', type: f32T, value: 0.2 },
              },
            },
            { s: 'return', expr: { op: 'varref', type: f32T, name: 'acc' } },
          ],
        },
      ],
    }
    expect(() => compileModule(m, { precision: 'f32' })).not.toThrow()
    expect(compileModule(m, { precision: 'f32' }).fns.k!(0.1)).toBe(
      Math.fround(Math.fround(0.1) + Math.fround(0.2)),
    )
    // the target itself is untouched in the rewritten IR
    const assignStmt = froundF32(m).funcs[0]!.body[1]!
    expect(assignStmt.s).toBe('assign')
    expect((assignStmt as { target: Expr }).target.op).toBe('varref')
  })

  it('is idempotent, and leaves non-f32 types alone', () => {
    const once = froundF32(addModule)
    expect(JSON.stringify(froundF32(once))).toBe(JSON.stringify(once))

    const intM: ModuleDecl = {
      consts: [],
      structs: [],
      bindings: [],
      funcs: [
        {
          name: 'k',
          params: [{ name: 'a', type: i32T }],
          ret: i32T,
          attrs: [],
          body: [{ s: 'return', expr: { op: 'param', type: i32T, name: 'a' } }],
        },
      ],
    }
    expect(JSON.stringify(froundF32(intM))).toBe(JSON.stringify(intM))
  })

  it('rounds component-wise over f32 vectors', () => {
    const m: ModuleDecl = {
      consts: [],
      structs: [],
      bindings: [],
      funcs: [
        {
          name: 'k',
          params: [{ name: 'a', type: vec2fT }],
          ret: vec2fT,
          attrs: [],
          body: [{ s: 'return', expr: { op: 'param', type: vec2fT, name: 'a' } }],
        },
      ],
    }
    expect(compileModule(m, { precision: 'f32' }).fns.k!([0.1, 16777217])).toEqual([
      Math.fround(0.1),
      16777216,
    ])
  })

  // The mode has to reach BOTH engines identically, or they stop being differentials of each
  // other. One shared BUILTINS entry should make that free; this is what proves it.
  it('the interpreter and the codegen agree in f32 mode', () => {
    for (const v of [0.1, 16777217, 1e30, -0, NaN, 1 / 3]) {
      const a = compileModule(addModule, { precision: 'f32' }).fns.k!(v)
      const b = compileModuleJs(addModule, { precision: 'f32' }).fns.k!(v)
      expect(Object.is(a, b), `v=${v}: interp=${a} js=${b}`).toBe(true)
    }
  })

  it('defaults to f64 — an omitted option changes nothing', () => {
    expect(compileModule(addModule).fns.k!(0.1)).toBe(compileModule(addModule, {}).fns.k!(0.1))
  })
})
