// ═══ df64 property-based tests — the algorithms under REAL f32 rounding ═══
//
// Companion to df64-known-answer.test.ts. That file pins a handful of hand-
// picked vectors; this one drives the SAME f32-rounding oracle (the actual
// lowered df64_* IR, every f32 op wrapped in Math.fround) with tens of thousands
// of SEEDED-random inputs across a wide exponent range, and asserts the general
// property: the df64 result tracks native f64 to df64 precision, while plain f32
// on the same inputs does not (so the coverage is provably non-vacuous).
//
// Seeded PRNG (not Math.random): a failure is reproducible and CI is deterministic.

import { describe, it, expect } from 'vitest'
import { fn, module, f64T, sqrt, abs, min, max, floor, fract } from '../ir'
import type { Expr, ModuleDecl, ShaderType } from '../ir'
import { compileModule, type CpuValue } from '../oracle'
import { fp64Lower } from '../passes/fp64-lower'
import { mapModuleExprs } from '../passes/opt/ir-transform'
import { splitF64 } from './df64-lib'

// ── The f32-rounding oracle (same mechanism as df64-known-answer.test.ts) ──

const isF32ish = (t: ShaderType): boolean =>
  (t.kind === 'scalar' && t.scalar === 'f32') || (t.kind === 'vec' && t.elem === 'f32')

const froundWrap = (e: Expr): Expr => {
  if ((e.op === 'binop' || e.op === 'unop' || e.op === 'call') && isF32ish(e.type)) {
    if (e.op === 'call' && e.fn === '__fround') return e
    return { op: 'call', type: e.type, fn: '__fround', args: [e] }
  }
  return e
}

function f32Oracle(m: ModuleDecl): ReturnType<typeof compileModule> {
  const cpu = compileModule(mapModuleExprs(fp64Lower(m), froundWrap))
  cpu.fns['__fround'] = (x: CpuValue) =>
    Array.isArray(x) ? (x as number[]).map(Math.fround) : Math.fround(x as number)
  return cpu
}

// ── Kernels: one fn per operation under test ──

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
    fn('k_le', { a: f64T, b: f64T }, (p) => p.a.le(p.b).select(1.0, 0.0)),
    fn('k_gt', { a: f64T, b: f64T }, (p) => p.a.gt(p.b).select(1.0, 0.0)),
    fn('k_ge', { a: f64T, b: f64T }, (p) => p.a.ge(p.b).select(1.0, 0.0)),
    fn('k_eq', { a: f64T, b: f64T }, (p) => p.a.eq(p.b).select(1.0, 0.0)),
    fn('k_ne', { a: f64T, b: f64T }, (p) => p.a.ne(p.b).select(1.0, 0.0)),
  ],
})
const cpu = f32Oracle(m)

// ── Helpers ──

// mulberry32: a tiny, fast, well-distributed seeded PRNG (deterministic).
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A df64 value near a random f64: (hi, lo) pair and its EXACT real value hi+lo
// (df64 spans ~48 bits, so hi+lo is exactly representable in f64 — a faithful
// reference input, not the wider double we sampled).
type Df = { pair: number[]; val: number }
const asDf = (x: number): Df => {
  const [hi, lo] = splitF64(x)
  return { pair: [hi, lo], val: hi! + lo! }
}
const val = (r: CpuValue): number => {
  const [hi, lo] = r as number[]
  return hi! + lo!
}

// Random f64 with a controllable exponent range and a full 53-bit-ish mantissa.
const sampler = (seed: number, expLo: number, expHi: number) => {
  const rnd = mulberry32(seed)
  return (): number => {
    const sign = rnd() < 0.5 ? -1 : 1
    const exp = expLo + Math.floor(rnd() * (expHi - expLo + 1))
    // two draws → ~44 random mantissa bits in [1, 2)
    const mant = 1 + rnd() + rnd() * 2 ** -26 // ~44 random mantissa bits in [1, 2)
    return sign * mant * 2 ** exp
  }
}

// Relative error against a reference, robust at ref ≈ 0 (cancellation).
const relErr = (got: number, ref: number): number =>
  ref === 0 ? Math.abs(got) : Math.abs(got - ref) / Math.abs(ref)

const N = 20000

// ── Arithmetic: df64 tracks f64; f32 on the same inputs does not ──

// Tolerances are the measured worst-case relative error over this seeded sweep
// plus ~2 bits of margin, so a >2-bit precision regression trips the test while
// the fixed seed keeps it from ever flaking. Observed worst (df64 | f32):
//   add 2^-47.2 | 2^-16.9   sub 2^-47.2 | 2^-15.1   mul 2^-46.2 | 2^-22.7
//   div 2^-45.5 | 2^-22.7   sqrt 2^-45.3 | 2^-23.5  — df64 is 24–32 bits ahead.
type Binop = {
  name: string
  kind: 'k_add' | 'k_sub' | 'k_mul' | 'k_div'
  ref: (a: number, b: number) => number
  f32: (a: number, b: number) => number
  tol: number
}
const BINOPS: Binop[] = [
  {
    name: 'add',
    kind: 'k_add',
    ref: (a, b) => a + b,
    f32: (a, b) => Math.fround(Math.fround(a) + Math.fround(b)),
    tol: 2 ** -45,
  },
  {
    name: 'sub',
    kind: 'k_sub',
    ref: (a, b) => a - b,
    f32: (a, b) => Math.fround(Math.fround(a) - Math.fround(b)),
    tol: 2 ** -45,
  },
  {
    name: 'mul',
    kind: 'k_mul',
    ref: (a, b) => a * b,
    f32: (a, b) => Math.fround(Math.fround(a) * Math.fround(b)),
    tol: 2 ** -44,
  },
  {
    name: 'div',
    kind: 'k_div',
    ref: (a, b) => a / b,
    f32: (a, b) => Math.fround(Math.fround(a) / Math.fround(b)),
    tol: 2 ** -43,
  },
]

describe('df64 arithmetic tracks f64 across random inputs (and f32 cannot)', () => {
  it.each(BINOPS)('$name: worst df64 error ≪ tol, worst f32 error ≫ df64', (op) => {
    const ra = sampler(0x1234 ^ op.name.charCodeAt(0), -28, 28)
    const rb = sampler(0x9abc ^ op.name.charCodeAt(1), -28, 28)
    let maxDf = 0,
      maxF32 = 0
    for (let i = 0; i < N; i++) {
      const a = asDf(ra()),
        b = asDf(rb())
      if (op.kind === 'k_div' && b.val === 0) continue
      const ref = op.ref(a.val, b.val)
      if (!isFinite(ref)) continue
      maxDf = Math.max(maxDf, relErr(val(cpu.fns[op.kind]!(a.pair, b.pair)), ref))
      maxF32 = Math.max(maxF32, relErr(op.f32(a.val, b.val), ref))
    }
    // Correctness: df64 stays inside df64 precision on EVERY sample.
    expect(maxDf).toBeLessThan(op.tol)
    // Non-vacuous: somewhere in the sweep, plain f32 is orders of magnitude worse.
    expect(maxF32).toBeGreaterThan(maxDf * 1e3)
    expect(maxF32).toBeGreaterThan(2 ** -30)
  })

  it('sqrt: worst df64 error ≪ 2^-43, worst f32 error ≫ df64', () => {
    const r = sampler(0x5eed, -24, 40)
    let maxDf = 0,
      maxF32 = 0
    for (let i = 0; i < N; i++) {
      const a = asDf(Math.abs(r()))
      const ref = Math.sqrt(a.val)
      if (!isFinite(ref) || ref === 0) continue
      maxDf = Math.max(maxDf, relErr(val(cpu.fns.k_sqrt!(a.pair)), ref))
      maxF32 = Math.max(maxF32, relErr(Math.fround(Math.sqrt(Math.fround(a.val))), ref))
    }
    expect(maxDf).toBeLessThan(2 ** -43)
    expect(maxF32).toBeGreaterThan(maxDf * 1e3)
    expect(maxF32).toBeGreaterThan(2 ** -30)
  })
})

// ── abs / min / max: exact selection at f64 resolution ──

describe('df64 selection is exact across random inputs', () => {
  it('abs / min / max reproduce the f64 result exactly', () => {
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
})

// ── Comparisons: agree with f64 ordering, including f32-indistinguishable pairs ──

describe('df64 comparisons agree with f64 ordering across random inputs', () => {
  const CMP = [
    ['k_lt', (a: number, b: number) => a < b],
    ['k_le', (a: number, b: number) => a <= b],
    ['k_gt', (a: number, b: number) => a > b],
    ['k_ge', (a: number, b: number) => a >= b],
    ['k_eq', (a: number, b: number) => a === b],
    ['k_ne', (a: number, b: number) => a !== b],
  ] as const

  it('all six comparators match the f64 predicate on random pairs', () => {
    const ra = sampler(0xc33, -28, 28),
      rb = sampler(0xd44, -28, 28)
    for (let i = 0; i < N; i++) {
      const a = asDf(ra()),
        b = asDf(rb())
      for (const [k, pred] of CMP) {
        expect(cpu.fns[k]!(a.pair, b.pair)).toBe(pred(a.val, b.val) ? 1 : 0)
      }
    }
  })

  it('near-equal pairs f32 conflates are still ordered by the lo word', () => {
    // b = a + one ulp(hi)/… so fround(a) === fround(b) but a.val < b.val.
    const r = sampler(0xe55, 4, 26)
    let exercised = 0
    for (let i = 0; i < N; i++) {
      const base = r()
      const a = asDf(base)
      const b = asDf(base + Math.abs(base) * 2 ** -34) // sub-f32-ulp bump
      if (Math.fround(a.val) !== Math.fround(b.val) || a.val === b.val) continue
      exercised++
      // f32-indistinguishable, yet df64 orders them by the low word:
      expect(cpu.fns.k_lt!(a.pair, b.pair)).toBe(1)
      expect(cpu.fns.k_lt!(b.pair, a.pair)).toBe(0)
      expect(cpu.fns.k_eq!(a.pair, b.pair)).toBe(0)
    }
    expect(exercised).toBeGreaterThan(1000) // the case is actually hit, not skipped away
  })
})

// ── floor / fract: the lo word decides at magnitudes f32 cannot hold ──

describe('df64 floor / fract track f64 across random inputs', () => {
  it('floor(x) and fract(x) match f64 for |x| up to 2^40', () => {
    const r = sampler(0xf66, -6, 40)
    let maxFractErr = 0
    for (let i = 0; i < N; i++) {
      const a = asDf(r())
      const refFloor = Math.floor(a.val)
      expect(val(cpu.fns.k_floor!(a.pair))).toBe(refFloor)
      // fract = x − ⌊x⌋ ∈ [0, 1); exact when the result is representable.
      const refFract = a.val - refFloor
      maxFractErr = Math.max(maxFractErr, Math.abs(val(cpu.fns.k_fract!(a.pair)) - refFract))
    }
    expect(maxFractErr).toBeLessThan(2 ** -45) // observed 2^-49 (EFT subtraction keeps the low word)
  })
})
