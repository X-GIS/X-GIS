// ═══ CPU tier — WGSL integer / min-max / control-flow semantics (#2274, #2275) ═══
//
// The two CPU engines (tree-walk interpreter in oracle.ts, `new Function` twin in
// cpu-codegen.ts) are the REFERENCE the GPU parity gates compare against. Both used
// to evaluate integer `/` as f64 division (`idiv(7, 2)` = 3.5, WGSL 3), model no
// integer wrap, and the interpreter dropped a `continue` raised inside a `switch`
// case within a loop. Every case here is asserted on BOTH engines against the value
// the WGSL spec defines; where GLSL ES 3.00 leaves the case undefined the WGSL value
// is the canonical one (WGSL is the canonical target; GLSL is translated from it).

import { describe, it, expect } from 'vitest'
import {
  fn,
  module,
  f32T,
  i32T,
  u32T,
  f32,
  i32,
  toI32,
  toU32,
  min,
  max,
  clamp,
  Var,
  Loop,
  Switch,
  Continue,
  Break,
  compileModule,
  compileModuleJs,
} from '../index.js'

const idiv = fn('idiv', { a: i32T, b: i32T }, ({ a, b }) => a.div(b))
const imod = fn('imod', { a: i32T, b: i32T }, ({ a, b }) => a.mod(b))
const iadd = fn('iadd', { a: i32T, b: i32T }, ({ a, b }) => a.add(b))
const isub = fn('isub', { a: i32T, b: i32T }, ({ a, b }) => a.sub(b))
const imul = fn('imul', { a: i32T, b: i32T }, ({ a, b }) => a.mul(b))
const iand = fn('iand', { a: i32T, b: i32T }, ({ a, b }) => a.bitAnd(b))
const ior = fn('ior', { a: i32T, b: i32T }, ({ a, b }) => a.bitOr(b))
const ixor = fn('ixor', { a: i32T, b: i32T }, ({ a, b }) => a.bitXor(b))
const ishl = fn('ishl', { a: i32T, b: u32T }, ({ a, b }) => a.shl(b))
const ishr = fn('ishr', { a: i32T, b: u32T }, ({ a, b }) => a.shr(b))
const udiv = fn('udiv', { a: u32T, b: u32T }, ({ a, b }) => a.div(b))
const umod = fn('umod', { a: u32T, b: u32T }, ({ a, b }) => a.mod(b))
const uadd = fn('uadd', { a: u32T, b: u32T }, ({ a, b }) => a.add(b))
const usub = fn('usub', { a: u32T, b: u32T }, ({ a, b }) => a.sub(b))
const umul = fn('umul', { a: u32T, b: u32T }, ({ a, b }) => a.mul(b))
const u2i = fn('u2i', { a: u32T }, ({ a }) => toI32(a))
const i2u = fn('i2u', { a: i32T }, ({ a }) => toU32(a))
const fmin = fn('fmin', { a: f32T, b: f32T }, ({ a, b }) => min(a, b))
const fmax = fn('fmax', { a: f32T, b: f32T }, ({ a, b }) => max(a, b))
const fclamp = fn('fclamp', { x: f32T, lo: f32T, hi: f32T }, ({ x, lo, hi }) => clamp(x, lo, hi))

// for (i = 0; i < n; i++) { switch (i) { case 1: { continue; } default: {} } acc += 1 }
const swcont = fn('swcont', { n: i32T }, ({ n }) => {
  const acc = Var(f32(0))
  Loop(
    i32(0),
    (i) => i.lt(n),
    (i) => {
      Switch(i)
        .case(1, () => {
          Continue()
        })
        .default(() => {})
      acc.assign(acc.add(1))
    },
  )
  return acc
})
// for (i = 0; i < n; i++) { switch (i) { case 1: { break; } default: {} } acc += 1 }
// — a `break` inside a switch case exits the SWITCH only, never the loop.
const swbrk = fn('swbrk', { n: i32T }, ({ n }) => {
  const acc = Var(f32(0))
  Loop(
    i32(0),
    (i) => i.lt(n),
    (i) => {
      Switch(i)
        .case(1, () => {
          Break()
        })
        .default(() => {})
      acc.assign(acc.add(1))
    },
  )
  return acc
})

const m = module({
  funcs: [
    idiv,
    imod,
    iadd,
    isub,
    imul,
    iand,
    ior,
    ixor,
    ishl,
    ishr,
    udiv,
    umod,
    uadd,
    usub,
    umul,
    u2i,
    i2u,
    fmin,
    fmax,
    fclamp,
    swcont,
    swbrk,
  ],
})

type Fns = Record<string, (...args: number[]) => number>
const engines: ReadonlyArray<readonly [string, Fns]> = [
  ['interpreter', compileModule(m).fns as unknown as Fns],
  ['codegen', compileModuleJs(m).fns as unknown as Fns],
]

const I32_MIN = -2147483648
const I32_MAX = 2147483647
const U32_MAX = 4294967295

describe.each(engines)('CPU tier (%s) — WGSL integer semantics (#2274)', (_name, F) => {
  it('i32 / and % truncate toward zero', () => {
    expect(F.idiv!(7, 2)).toBe(3)
    expect(F.idiv!(-7, 2)).toBe(-3)
    expect(F.idiv!(7, -2)).toBe(-3)
    expect(F.imod!(-7, 2)).toBe(-1)
    expect(F.imod!(7, -2)).toBe(1)
  })
  it('u32 / and % are integer', () => {
    expect(F.udiv!(7, 2)).toBe(3)
    expect(F.umod!(7, 2)).toBe(1)
    expect(F.udiv!(U32_MAX, 2)).toBe(2147483647)
  })
  it('division and remainder by zero follow WGSL: x / 0 = x, x % 0 = 0', () => {
    expect(F.idiv!(7, 0)).toBe(7)
    expect(F.idiv!(-7, 0)).toBe(-7)
    expect(F.imod!(7, 0)).toBe(0)
    expect(F.udiv!(7, 0)).toBe(7)
    expect(F.umod!(7, 0)).toBe(0)
  })
  it('i32 MIN / -1 overflows to MIN and MIN % -1 is 0 (WGSL)', () => {
    expect(F.idiv!(I32_MIN, -1)).toBe(I32_MIN)
    expect(F.imod!(I32_MIN, -1)).toBe(0)
  })
  it('+ - * wrap modulo 2^32 with the operand kind', () => {
    expect(F.uadd!(U32_MAX, 1)).toBe(0)
    expect(F.usub!(0, 1)).toBe(U32_MAX)
    expect(F.umul!(65536, 65536)).toBe(0)
    expect(F.umul!(U32_MAX, U32_MAX)).toBe(1)
    expect(F.iadd!(I32_MAX, 1)).toBe(I32_MIN)
    expect(F.isub!(I32_MIN, 1)).toBe(I32_MAX)
    expect(F.imul!(65536, 32768)).toBe(I32_MIN)
    expect(F.imul!(-3, 7)).toBe(-21)
  })
  it('i32 bitwise results stay i32 (negative), u32 results stay u32', () => {
    expect(F.iand!(-1, -1)).toBe(-1)
    expect(F.ior!(-2, 1)).toBe(-1)
    expect(F.ixor!(-1, 0)).toBe(-1)
    expect(F.ishl!(-1, 1)).toBe(-2)
    expect(F.ishr!(-8, 1)).toBe(-4)
    expect(F.ishl!(1, 31)).toBe(I32_MIN)
  })
  it('u32 ↔ i32 conversion reinterprets the bits', () => {
    expect(F.u2i!(U32_MAX)).toBe(-1)
    expect(F.u2i!(2147483648)).toBe(I32_MIN)
    expect(F.u2i!(7)).toBe(7)
    expect(F.i2u!(-1)).toBe(U32_MAX)
    expect(F.i2u!(I32_MIN)).toBe(2147483648)
    expect(F.i2u!(7)).toBe(7)
  })
  it('min / max return the non-NaN operand (WGSL)', () => {
    expect(F.fmin!(NaN, 1)).toBe(1)
    expect(F.fmin!(1, NaN)).toBe(1)
    expect(F.fmax!(NaN, 1)).toBe(1)
    expect(F.fmax!(1, NaN)).toBe(1)
    expect(F.fmin!(2, 1)).toBe(1)
    expect(F.fmax!(2, 1)).toBe(2)
  })
  it('clamp is min(max(x, lo), hi) — the formula WGSL lists first and GLSL defines', () => {
    // lo > hi is implementation-defined on WGSL (either min(max(e,lo),hi) or the median);
    // GLSL ES 3.00 defines only min(max(x,lo),hi). The oracle follows that formula so it
    // is one of the WGSL-permitted results and the GLSL one — never a third formula.
    expect(F.fclamp!(5, 3, 1)).toBe(1)
    expect(F.fclamp!(0.5, 0, 1)).toBe(0.5)
    expect(F.fclamp!(-2, 0, 1)).toBe(0)
    expect(F.fclamp!(2, 0, 1)).toBe(1)
  })
})

describe.each(engines)('CPU tier (%s) — switch inside a loop (#2275)', (_name, F) => {
  it('a continue raised inside a switch case reaches the enclosing loop', () => {
    expect(F.swcont!(4)).toBe(3)
  })
  it('a break inside a switch case exits the switch only, never the loop', () => {
    expect(F.swbrk!(4)).toBe(4)
  })
})
