// ═══ INTEGER-flavor df64 property tests — the integer EFT under the fround oracle ═══
//
// The float flavor's companion suite (df64-property.test.ts) drives the lowered
// df64_* IR with tens of thousands of seeded-random inputs under REAL f32
// rounding. This file runs the SAME gate against `fp64Lower(m, { flavor:
// 'integer' })` — the integer-exact EFT primitives of df64-int.ts — plus the
// directed edge vectors the integer rounding tail specifically owes an answer
// to: RNE ties-to-even, mantissa carry on round-up (2^24 renormalize), exact
// cancellation → +0, the far-path boundary (d = 25 vs 26), and gradual
// underflow. Bit-exactness bar: where the float flavor is merely accurate, the
// integer flavor's s word must equal fround(exact) EXACTLY (it computes the
// true sum/product and rounds once).

import { describe, it, expect } from 'vitest'
import { fn, module, f64T, sqrt, abs, min, max, floor, fract } from '../ir'
import type { Expr, ModuleDecl, ShaderType } from '../ir'
import { compileModule, type CpuValue } from '../oracle'
import { fp64Lower } from '../passes/fp64-lower'
import { mapModuleExprs } from '../passes/opt/ir-transform'
import { splitF64 } from './df64-lib'

// ── The f32-rounding oracle, integer flavor ──

const isF32ish = (t: ShaderType): boolean =>
  (t.kind === 'scalar' && t.scalar === 'f32') || (t.kind === 'vec' && t.elem === 'f32')

const froundWrap = (e: Expr): Expr => {
  if ((e.op === 'binop' || e.op === 'unop' || e.op === 'call') && isF32ish(e.type)) {
    if (e.op === 'call' && e.fn === '__fround') return e
    return { op: 'call', type: e.type, fn: '__fround', args: [e] }
  }
  return e
}

function intOracle(m: ModuleDecl): ReturnType<typeof compileModule> {
  const cpu = compileModule(mapModuleExprs(fp64Lower(m, { flavor: 'integer' }), froundWrap))
  cpu.fns['__fround'] = (x: CpuValue) =>
    Array.isArray(x) ? (x as number[]).map(Math.fround) : Math.fround(x as number)
  return cpu
}

// ── Kernels ──

const m = module({
  funcs: [
    fn('k_add', { a: f64T, b: f64T }, (p) => p.a.add(p.b)),
    fn('k_sub', { a: f64T, b: f64T }, (p) => p.a.sub(p.b)),
    fn('k_mul', { a: f64T, b: f64T }, (p) => p.a.mul(p.b)),
    fn('k_div', { a: f64T, b: f64T }, (p) => p.a.div(p.b)),
    fn('k_sqrt', { a: f64T }, (p) => sqrt(p.a)),
    fn('k_abs', { a: f64T }, (p) => abs(p.a)),
    fn('k_min', { a: f64T, b: f64T }, (p) => min(p.a, p.b)),
    fn('k_max', { a: f64T, b: f64T }, (p) => max(p.a, p.b)),
    fn('k_floor', { a: f64T }, (p) => floor(p.a)),
    fn('k_fract', { a: f64T }, (p) => fract(p.a)),
    fn('k_lt', { a: f64T, b: f64T }, (p) => p.a.lt(p.b).select(1.0, 0.0)),
    fn('k_eq', { a: f64T, b: f64T }, (p) => p.a.eq(p.b).select(1.0, 0.0)),
  ],
})
const cpu = intOracle(m)

// ── Helpers (same conventions as the float suite) ──

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Df = { pair: number[]; val: number }
const asDf = (x: number): Df => {
  const [hi, lo] = splitF64(x)
  return { pair: [hi, lo], val: hi! + lo! }
}
const val = (r: CpuValue): number => {
  const [hi, lo] = r as number[]
  return hi! + lo!
}

const sampler = (seed: number, expLo: number, expHi: number) => {
  const rnd = mulberry32(seed)
  return (): number => {
    const sign = rnd() < 0.5 ? -1 : 1
    const exp = expLo + Math.floor(rnd() * (expHi - expLo + 1))
    const mant = 1 + rnd() + rnd() * 2 ** -26
    return sign * mant * 2 ** exp
  }
}

const relErr = (got: number, ref: number): number =>
  ref === 0 ? Math.abs(got) : Math.abs(got - ref) / Math.abs(ref)

const N = 20000

// ── Random sweeps: same bar as the float flavor ──

type Binop = {
  name: string
  kind: 'k_add' | 'k_sub' | 'k_mul' | 'k_div'
  ref: (a: number, b: number) => number
  tol: number
}
const BINOPS: Binop[] = [
  { name: 'add', kind: 'k_add', ref: (a, b) => a + b, tol: 2 ** -45 },
  { name: 'sub', kind: 'k_sub', ref: (a, b) => a - b, tol: 2 ** -45 },
  { name: 'mul', kind: 'k_mul', ref: (a, b) => a * b, tol: 2 ** -44 },
  { name: 'div', kind: 'k_div', ref: (a, b) => a / b, tol: 2 ** -43 },
]

describe('integer-flavor df64 arithmetic tracks f64 across random inputs', () => {
  it.each(BINOPS)('$name: worst error inside the float-flavor tolerance', (op) => {
    const ra = sampler(0x1234 ^ op.name.charCodeAt(0), -28, 28)
    const rb = sampler(0x9abc ^ op.name.charCodeAt(1), -28, 28)
    let maxDf = 0
    for (let i = 0; i < N; i++) {
      const a = asDf(ra()),
        b = asDf(rb())
      if (op.kind === 'k_div' && b.val === 0) continue
      const ref = op.ref(a.val, b.val)
      if (!isFinite(ref)) continue
      maxDf = Math.max(maxDf, relErr(val(cpu.fns[op.kind]!(a.pair, b.pair)), ref))
    }
    expect(maxDf).toBeLessThan(op.tol)
  })

  it('sqrt: worst error < 2^-43', () => {
    const r = sampler(0x5eed, -24, 40)
    let maxDf = 0
    for (let i = 0; i < N; i++) {
      const a = asDf(Math.abs(r()))
      const ref = Math.sqrt(a.val)
      if (!isFinite(ref) || ref === 0) continue
      maxDf = Math.max(maxDf, relErr(val(cpu.fns.k_sqrt!(a.pair)), ref))
    }
    expect(maxDf).toBeLessThan(2 ** -43)
  })

  it('add/mul hi word is BIT-EXACT fround of the true result (single rounding)', () => {
    // Stronger than the float flavor can promise: the integer twoSum/twoProd
    // compute the exact sum/product, so the s word must equal fround(exact)
    // whenever both inputs are pure f32 (lo = 0) and the result is in range.
    const r1 = sampler(0xbee1, -12, 12)
    const r2 = sampler(0xbee2, -12, 12)
    for (let i = 0; i < 4000; i++) {
      const a = Math.fround(r1())
      const b = Math.fround(r2())
      const add = cpu.fns.k_add!([a, 0], [b, 0]) as number[]
      expect(add[0]).toBe(Math.fround(a + b))
      const mul = cpu.fns.k_mul!([a, 0], [b, 0]) as number[]
      expect(mul[0]).toBe(Math.fround(a * b))
    }
  })
})

// ── Selection / comparison / floor·fract ──

describe('integer-flavor selection, comparison, floor/fract', () => {
  it('abs / min / max are exact', () => {
    const ra = sampler(0xa11, -28, 28),
      rb = sampler(0xb22, -28, 28)
    for (let i = 0; i < N; i++) {
      const a = asDf(ra()),
        b = asDf(rb())
      expect(val(cpu.fns.k_abs!(a.pair))).toBe(Math.abs(a.val))
      expect(val(cpu.fns.k_min!(a.pair, b.pair))).toBe(Math.min(a.val, b.val))
      expect(val(cpu.fns.k_max!(a.pair, b.pair))).toBe(Math.max(a.val, b.val))
    }
  })

  it('lt/eq agree with f64 ordering (sub-f32-ulp pairs included)', () => {
    const r = sampler(0xe55, 4, 26)
    for (let i = 0; i < 4000; i++) {
      const base = r()
      const a = asDf(base)
      const b = asDf(base + Math.abs(base) * 2 ** -34)
      if (a.val === b.val) continue
      expect(cpu.fns.k_lt!(a.pair, b.pair)).toBe(1)
      expect(cpu.fns.k_eq!(a.pair, b.pair)).toBe(0)
    }
  })

  it('floor / fract match f64 up to 2^40', () => {
    const r = sampler(0xf66, -6, 40)
    let maxFractErr = 0
    for (let i = 0; i < N; i++) {
      const a = asDf(r())
      const refFloor = Math.floor(a.val)
      expect(val(cpu.fns.k_floor!(a.pair))).toBe(refFloor)
      maxFractErr = Math.max(
        maxFractErr,
        Math.abs(
          val(cpu.fns.k_fract!(a.pair)) - refFloor === 0
            ? val(cpu.fns.k_fract!(a.pair)) - (a.val - refFloor)
            : val(cpu.fns.k_fract!(a.pair)) - (a.val - refFloor),
        ),
      )
    }
    expect(maxFractErr).toBeLessThan(2 ** -45)
  })
})

// ── Directed edges the integer rounding tail specifically owes ──

describe('integer-flavor directed edge vectors', () => {
  const add = (a: number[], b: number[]): number[] => cpu.fns.k_add!(a, b) as number[]
  const mul = (a: number[], b: number[]): number[] => cpu.fns.k_mul!(a, b) as number[]

  it('RNE tie rounds to even (both directions)', () => {
    // 1 + 2^-24 is an exact tie between 1 and 1+2^-23 → even mantissa → 1.
    const s = add([1, 0], [2 ** -24, 0])
    expect(s[0]).toBe(1)
    expect(s[1]).toBe(2 ** -24) // exact residual preserved
    // (1+2^-23) + 2^-24 ties upward to the even 1+2^-22.
    const t = add([1 + 2 ** -23, 0], [2 ** -24, 0])
    expect(t[0]).toBe(Math.fround(1 + 2 ** -23 + 2 ** -24))
    expect(t[0]! + t[1]!).toBe(1 + 2 ** -23 + 2 ** -24)
  })

  it('round-up mantissa carry renormalizes (2^24 → 2^23, exponent +1)', () => {
    // (2 − 2^-24) + 2^-25·1.5 → exact sum just below 2, rounds up to 2.
    const a = Math.fround(2 - 2 ** -23)
    const s = add([a, 0], [2 ** -23 * 0.75, 0])
    expect(s[0]! + s[1]!).toBe(a + 2 ** -23 * 0.75)
  })

  it('exact cancellation returns +0 (not −0)', () => {
    const s = add([1.5, 0], [-1.5, 0])
    expect(Object.is(s[0], 0) || Object.is(s[0], -0) ? Math.sign(1 / s[0]!) : NaN).toBe(1)
    expect(s[1]).toBe(0)
  })

  it('far-path boundary: d = 25 rounds, d = 26 passes through', () => {
    for (const dexp of [25, 26, 30]) {
      const big = 1
      const tiny = 2 ** -dexp * 1.25 // forces rounding interaction at d = 25
      const s = add([big, 0], [tiny, 0])
      expect(s[0]! + s[1]!).toBe(big + tiny) // exact pair either way
      expect(s[0]).toBe(Math.fround(big + tiny))
    }
  })

  it('product residual is exact across magnitudes', () => {
    const r = sampler(0xfeed, -20, 20)
    for (let i = 0; i < 4000; i++) {
      const a = Math.fround(r())
      const b = Math.fround(r())
      const p = mul([a, 0], [b, 0])
      // p.hi + p.lo == a·b exactly (both f32 → product fits 48 bits ⊂ f64)
      expect(p[0]! + p[1]!).toBe(a * b)
    }
  })

  it('gradual underflow: results below 2^-126 keep RNE denormal precision', () => {
    const a = 2 ** -120
    const b = 2 ** -10 * 1.5
    const p = mul([a, 0], [b, 0]) // 1.5·2^-130, denormal
    expect(p[0]).toBe(Math.fround(a * b))
  })
})
