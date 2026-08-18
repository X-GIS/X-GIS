import { describe, expect, it } from 'vitest'
import {
  module,
  fn,
  f32T,
  u32T,
  vec2fT,
  vec3fT,
  type ReadonlyNode,
  sinh,
  cosh,
  tanh,
  asinh,
  acosh,
  atanh,
  saturate,
  tan,
  atan,
  exp,
  log,
  pack2x16float,
  unpack2x16float,
  pack2x16unorm,
  unpack2x16unorm,
  pack2x16snorm,
  unpack2x16snorm,
  toU32,
  toI32,
} from './index.js'
import { emitModule } from '../backends/wgsl.js'
import { emitGlslModule } from '../backends/glsl.js'
import { compileModule } from '../oracle.js'
import { spellIntrinsic } from '../intrinsics.js'

// The 2026-08 builtin batch: the six hyperbolics (portable — WGSL §17.5 and
// GLSL ES 3.00 §8.1 both spell them natively), saturate (WGSL-native, GLSL
// inlines the defining clamp), the six NATIVE 2×16 pack/unpack renames, and the
// round → roundEven GLSL reclassification. Each new id must (1) emit its WGSL
// spelling, (2) evaluate on the CPU oracle (the two-oracle contract), and
// (3) map to the right GLSL spelling. The real-driver compile/execute proof
// lives in playground/e2e/_dsl-builtin-gate.spec.ts.

describe('extended stdlib builtins — WGSL emit', () => {
  it('emits each new builtin spelling', () => {
    const wgsl = emitModule(
      module({
        funcs: [
          fn('a', { x: f32T }, ({ x }) => sinh(x)),
          fn('b', { x: f32T }, ({ x }) => cosh(x)),
          fn('c', { x: f32T }, ({ x }) => tanh(x)),
          fn('d', { x: f32T }, ({ x }) => asinh(x)),
          fn('e', { x: f32T }, ({ x }) => acosh(x)),
          fn('g', { x: f32T }, ({ x }) => atanh(x)),
          fn('h', { x: vec3fT }, ({ x }) => saturate(x)),
          fn('j', { v: vec2fT }, ({ v }) => pack2x16float(v)),
          fn('k', { u: u32T }, ({ u }) => unpack2x16float(u)),
          fn('l', { v: vec2fT }, ({ v }) => pack2x16unorm(v)),
          fn('m', { u: u32T }, ({ u }) => unpack2x16unorm(u)),
          fn('n', { v: vec2fT }, ({ v }) => pack2x16snorm(v)),
          fn('o', { u: u32T }, ({ u }) => unpack2x16snorm(u)),
        ],
      }),
    )
    for (const s of [
      'sinh(',
      'cosh(',
      'tanh(',
      'asinh(',
      'acosh(',
      'atanh(',
      'saturate(',
      'pack2x16float(',
      'unpack2x16float(',
      'pack2x16unorm(',
      'unpack2x16unorm(',
      'pack2x16snorm(',
      'unpack2x16snorm(',
    ]) {
      expect(wgsl).toContain(s)
    }
  })
})

describe('extended stdlib builtins — GLSL spelling', () => {
  it('hyperbolics fall through as identity (native in GLSL ES 3.00 §8.1)', () => {
    for (const f of ['sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh']) {
      expect(spellIntrinsic('glsl', f, ['x'])).toBe(`${f}(x)`)
      expect(spellIntrinsic('wgsl', f, ['x'])).toBe(`${f}(x)`)
    }
  })
  it('saturate → the defining clamp on GLSL; native saturate on WGSL', () => {
    expect(spellIntrinsic('wgsl', 'saturate', ['x'])).toBe('saturate(x)')
    expect(spellIntrinsic('glsl', 'saturate', ['x'])).toBe('clamp(x, 0.0, 1.0)')
  })
  it('round → roundEven on GLSL (ES 3.00 round() is implementation-chosen at halves)', () => {
    expect(spellIntrinsic('wgsl', 'round', ['x'])).toBe('round(x)')
    expect(spellIntrinsic('glsl', 'round', ['x'])).toBe('roundEven(x)')
  })
  it('2×16 pack/unpack → the GLSL ES 3.00 §8.4 names (pure renames)', () => {
    const pairs: Array<[string, string]> = [
      ['pack2x16float', 'packHalf2x16'],
      ['unpack2x16float', 'unpackHalf2x16'],
      ['pack2x16unorm', 'packUnorm2x16'],
      ['unpack2x16unorm', 'unpackUnorm2x16'],
      ['pack2x16snorm', 'packSnorm2x16'],
      ['unpack2x16snorm', 'unpackSnorm2x16'],
    ]
    for (const [id, glsl] of pairs) {
      expect(spellIntrinsic('wgsl', id, ['v'])).toBe(`${id}(v)`)
      expect(spellIntrinsic('glsl', id, ['v'])).toBe(`${glsl}(v)`)
    }
  })
})

describe('extended stdlib builtins — CPU oracle eval', () => {
  const compile1 = (
    build: (x: ReadonlyNode<'f32'>) => ReadonlyNode<string>,
  ): ((x: number) => number) =>
    compileModule(module({ funcs: [fn('f', { x: f32T }, ({ x }) => build(x))] })).fns.f as (
      x: number,
    ) => number

  it('the ln2 closed family: sinh/cosh/tanh at ln2, and their inverses back', () => {
    // sinh(ln2) = (2 − ½)/2 = 0.75, cosh(ln2) = 1.25, tanh(ln2) = 0.6 — and the
    // inverse of each recovers ln2, pinning all six with one exact family.
    expect(compile1((x) => sinh(x))(Math.LN2)).toBeCloseTo(0.75, 12)
    expect(compile1((x) => cosh(x))(Math.LN2)).toBeCloseTo(1.25, 12)
    expect(compile1((x) => tanh(x))(Math.LN2)).toBeCloseTo(0.6, 12)
    expect(compile1((x) => asinh(x))(0.75)).toBeCloseTo(Math.LN2, 12)
    expect(compile1((x) => acosh(x))(1.25)).toBeCloseTo(Math.LN2, 12)
    expect(compile1((x) => atanh(x))(0.6)).toBeCloseTo(Math.LN2, 12)
  })

  it('hyperbolics are component-wise over vectors', () => {
    const f = compileModule(module({ funcs: [fn('f', { v: vec2fT }, ({ v }) => sinh(v))] })).fns
      .f as (v: number[]) => number[]
    const [a, b] = f([0, Math.LN2])
    expect(a).toBe(0)
    expect(b).toBeCloseTo(0.75, 12)
  })

  it('saturate clamps to [0,1], scalar and component-wise', () => {
    expect(compile1((x) => saturate(x))(1.5)).toBe(1)
    expect(compile1((x) => saturate(x))(-0.5)).toBe(0)
    expect(compile1((x) => saturate(x))(0.25)).toBe(0.25)
    const f = compileModule(module({ funcs: [fn('f', { v: vec3fT }, ({ v }) => saturate(v))] })).fns
      .f as (v: number[]) => number[]
    expect(f([-1, 0.5, 2])).toEqual([0, 0.5, 1])
  })

  it('pack2x16float: component 0 in the low bits, RTE f16 quantisation', () => {
    const pack = compileModule(
      module({ funcs: [fn('f', { v: vec2fT }, ({ v }) => pack2x16float(v))] }),
    ).fns.f as (v: number[]) => number
    // 0.1 → f16 0x2E66 (the canonical RTE rounding case); 1.5 → 0x3E00 (exact).
    expect(pack([0.1, 1.5])).toBe(0x3e002e66)
    // f16-max 65504 is exact; 65520 is the halfway case and rounds (RTE) to +Inf (0x7c00).
    expect(pack([65504, 65520])).toBe(0x7c007bff)
  })

  it('unpack2x16float is the exact inverse for representable values', () => {
    const unpack = compileModule(
      module({ funcs: [fn('f', { u: u32T }, ({ u }) => unpack2x16float(u))] }),
    ).fns.f as (u: number) => number[]
    expect(unpack(0x3e002e66)).toEqual([0.0999755859375, 1.5])
    // Negative + subnormal: −2.25 = 0xC080; smallest subnormal 2^−24 = 0x0001.
    expect(unpack(0xc0800001)).toEqual([2 ** -24, -2.25])
  })

  it('pack/unpack 2x16unorm: WGSL ⌊0.5 + 65535·clamp⌋ per lane', () => {
    const pack = compileModule(
      module({ funcs: [fn('f', { v: vec2fT }, ({ v }) => pack2x16unorm(v))] }),
    ).fns.f as (v: number[]) => number
    expect(pack([0, 1])).toBe(0xffff0000)
    expect(pack([0.5, 0.25])).toBe((16384 << 16) | 32768) // 32767.5 rounds up (⌊0.5+x⌋)
    expect(pack([-2, 3])).toBe(0xffff0000) // clamp binds
    const unpack = compileModule(
      module({ funcs: [fn('f', { u: u32T }, ({ u }) => unpack2x16unorm(u))] }),
    ).fns.f as (u: number) => number[]
    expect(unpack(0xffff0000)).toEqual([0, 1])
  })

  it('pack/unpack 2x16snorm: two’s complement lanes, −32768 clamps to −1 on unpack', () => {
    const pack = compileModule(
      module({ funcs: [fn('f', { v: vec2fT }, ({ v }) => pack2x16snorm(v))] }),
    ).fns.f as (v: number[]) => number
    expect(pack([-1, 1])).toBe(0x7fff8001)
    expect(pack([-0.5, 0.5])).toBe(((16384 << 16) | 0xc001) >>> 0) // ±16383.5 → −16383 / +16384 (⌊0.5+x⌋)
    const unpack = compileModule(
      module({ funcs: [fn('f', { u: u32T }, ({ u }) => unpack2x16snorm(u))] }),
    ).fns.f as (u: number) => number[]
    expect(unpack(0x7fff8001)).toEqual([-1, 1])
    // 0x8000 is −32768: −32768/32767 < −1, so the spec clamp binds exactly here.
    expect(unpack(0x00008000)).toEqual([-1, 0])
  })
})

describe('extended stdlib builtins — the Mercator identities (metamorphic)', () => {
  it('asinh(tan φ) ≡ log(tan(π/4 + φ/2)) over the Mercator latitude range', () => {
    const m = compileModule(
      module({
        funcs: [
          fn('viaAsinh', { lat: f32T }, ({ lat }) => asinh(tan(lat))),
          fn('viaLogTan', { lat: f32T }, ({ lat }) => log(tan(lat.mul(0.5).add(Math.PI / 4)))),
        ],
      }),
    ).fns
    for (let deg = -85; deg <= 85; deg += 5) {
      const rad = (deg * Math.PI) / 180
      expect(m.viaAsinh(rad)).toBeCloseTo(m.viaLogTan(rad) as number, 10)
    }
  })

  it('atan(sinh y) ≡ 2·atan(exp y) − π/2 over the Mercator Y range', () => {
    const m = compileModule(
      module({
        funcs: [
          fn('viaSinh', { y: f32T }, ({ y }) => atan(sinh(y))),
          fn('viaExp', { y: f32T }, ({ y }) =>
            atan(exp(y))
              .mul(2)
              .sub(Math.PI / 2),
          ),
        ],
      }),
    ).fns
    for (let y = -3.2; y <= 3.2; y += 0.4) {
      expect(m.viaSinh(y)).toBeCloseTo(m.viaExp(y) as number, 12)
    }
  })
})

describe('float→int casts — the CPU mirror follows WGSL saturation', () => {
  // WGSL float→integer conversion SATURATES (Tint polyfills it on every driver):
  // u32(-0.75) is 0, u32(4.5e9) is 4294967295, i32(-3e9) is -2147483648, NaN → 0.
  // The mirror used to wrap (u32(-0.75) → 4294967295 via >>>0) — a plausible-wrong
  // divergence for any dispatch value that dips below 0 by rounding. Integer-SOURCE
  // casts keep two's-complement wrapping (u32 of i32(-1) IS 0xFFFFFFFF), which the
  // value alone cannot distinguish — the twins branch on the arg's static type.
  it('toU32 of a negative float saturates to 0 (was: wrapped to 4294967295)', () => {
    const f = compileModule(module({ funcs: [fn('f', { x: f32T }, ({ x }) => toU32(x))] })).fns
      .f as (x: number) => number
    expect(f(-0.75)).toBe(0)
    // 4294967040 = 2^32 − 256, the largest u32 exactly representable in f32 — the bound
    // Tint's polyfill clamps against (measured by the GPU gate), NOT the mathematical
    // 2^32 − 1, which no float source can produce.
    expect(f(4.5e9)).toBe(4294967040)
    expect(f(7.25)).toBe(7)
  })
  it('toI32 of an out-of-range float saturates (was: kept the raw JS value)', () => {
    const f = compileModule(module({ funcs: [fn('f', { x: f32T }, ({ x }) => toI32(x))] })).fns
      .f as (x: number) => number
    expect(f(-3e9)).toBe(-2147483648) // −2^31 IS f32-exact — the lower bound stays mathematical
    expect(f(3e9)).toBe(2147483520) // 2^31 − 128, the largest i32 exactly representable in f32
    expect(f(-7.25)).toBe(-7)
  })
  it('integer-source casts KEEP wrapping — u32(i32 −1) is 0xFFFFFFFF on every target', () => {
    const f = compileModule(module({ funcs: [fn('f', { x: f32T }, ({ x }) => toU32(toI32(x)))] }))
      .fns.f as (x: number) => number
    expect(f(-1)).toBe(4294967295)
  })
})

describe('float % — the .mod METHOD is now portable (GLSL % is integer-only)', () => {
  it('GLSL spells float % as WGSL trunc-mod; int % stays native; WGSL unchanged', () => {
    const m = module({
      funcs: [
        fn('fm', { a: f32T, b: f32T }, ({ a, b }) => a.mod(b)),
        fn('im', { p: u32T, q: u32T }, ({ p, q }) => p.mod(q)),
      ],
    })
    const glsl = emitGlslModule(m, 'fragment')
    // Deliberately NOT GLSL mod() (floor-mod): trunc-mod matches WGSL float-%
    // AND the CPU oracle's JS `%`, so all three backends agree on negatives.
    expect(glsl).toContain('(a - b * trunc(a / b))')
    expect(glsl).toContain('(p % q)')
    const wgsl = emitModule(m)
    expect(wgsl).toContain('(a % b)') // WGSL keeps its native float % — bytes unchanged
    expect(wgsl).toContain('(p % q)')
  })
})
