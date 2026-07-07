// ═══ df64 known-answer tests — the algorithms under REAL f32 rounding ═══
//
// The CPU oracle evaluates in exact f64, which makes it structurally blind to
// the one thing df64 exists for: f32 rounding. These tests close that gap on
// the CPU by evaluating the ACTUAL lowered IR under an f32-rounding regime:
// every f32-typed binop/call/unop result is wrapped in a `__fround` call
// (Math.fround), so each operation rounds exactly as a correctly-rounding f32
// ALU would. That exercises the real df64_* bodies fp64Lower injected — not a
// hand-written mirror of them — against known-answer vectors that plain f32
// arithmetic PROVABLY cannot produce (each case asserts the f32 failure too,
// so a test that df64 passes vacuously would fail its discriminative half).
//
// What this cannot see: downstream shader-compiler fast-math (reassociation /
// contraction). That is the real-GPU known-answer e2e's job
// (playground/e2e/_fp64-known-answer.spec.ts).

import { describe, it, expect } from 'vitest'
import {
  fn,
  module,
  f64T,
  sqrt,
  abs,
  min,
  max,
  mix,
  floor,
  fract,
  toF32,
  f32T,
  f64FromParts,
  f64Parts,
} from '../ir'
import type { Expr, ModuleDecl, ShaderType } from '../ir'
import { compileModule, type CpuValue } from '../oracle'
import { fp64Lower } from '../passes/fp64-lower'
import { mapModuleExprs } from '../passes/opt/ir-transform'
import { splitF64 } from './df64-lib'

// ── The f32-rounding oracle ──

const isF32ish = (t: ShaderType): boolean =>
  (t.kind === 'scalar' && t.scalar === 'f32') || (t.kind === 'vec' && t.elem === 'f32')

/** Wrap every value-producing f32 op in `__fround(...)` so the oracle's exact
 *  f64 evaluation rounds to f32 after each operation — a correctly-rounding
 *  f32 machine over the SAME IR the GPU receives. */
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

// ── The kernel module (one fn per operation under test) ──

// No guard declaration — fp64Lower auto-injects the `_fp64` uniform.
const m = module({
  funcs: [
    fn('k_add', { a: f64T, b: f64T }, (p) => p.a.add(p.b)),
    fn('k_mul', { a: f64T, b: f64T }, (p) => p.a.mul(p.b)),
    fn('k_div', { a: f64T, b: f64T }, (p) => p.a.div(p.b)),
    fn('k_sqrt', { a: f64T }, (p) => sqrt(p.a)),
    fn('k_abs', { a: f64T }, (p) => abs(p.a)),
    fn('k_min', { a: f64T, b: f64T }, (p) => min(p.a, p.b)),
    fn('k_max', { a: f64T, b: f64T }, (p) => max(p.a, p.b)),
    fn('k_mix', { a: f64T, b: f64T, t: f32T }, (p) => mix(p.a, p.b, p.t)),
    fn('k_floor', { a: f64T }, (p) => floor(p.a)),
    fn('k_fract', { a: f64T }, (p) => fract(p.a)),
    fn('k_lt', { a: f64T, b: f64T }, (p) => p.a.lt(p.b).select(1.0, 0.0)),
    fn('k_narrow', { a: f64T }, (p) => toF32(p.a)),
    // The DSFUN lane bridge: (hi, lo) f32 lanes → f64 → arithmetic → pair out.
    fn('k_parts', { hi: f32T, lo: f32T, b: f64T }, (p) =>
      f64Parts(f64FromParts(p.hi, p.lo).add(p.b)),
    ),
  ],
})

const cpu = f32Oracle(m)
const val = (r: CpuValue): number => {
  const [hi, lo] = r as number[]
  return hi! + lo!
}
const pair = (x: number): number[] => splitF64(x)

describe('df64 known answers under f32 rounding (deep cancellation)', () => {
  it('(2^20 + 2^-20) − 2^20 == 2^-20 — 41 significand bits, impossible in f32', () => {
    const a = 2 ** 20 + 2 ** -20
    // Discriminative half: plain f32 loses the tail entirely.
    expect(Math.fround(Math.fround(a) - 2 ** 20)).toBe(0)
    const r = cpu.fns.k_add!(pair(a), pair(-(2 ** 20)))
    expect(val(r)).toBe(2 ** -20)
  })

  it('(1e8 + 0.5) − 1e8 == 0.5 — the classic deep-zoom coordinate case', () => {
    const a = 1e8 + 0.5
    expect(Math.fround(Math.fround(a) - 1e8)).toBe(0)
    const r = cpu.fns.k_add!(pair(a), pair(-1e8))
    expect(val(r)).toBe(0.5)
  })

  it('f64FromParts / f64Parts bridge hi/lo lanes losslessly through arithmetic', () => {
    const [hi, lo] = splitF64(2 ** 20 + 2 ** -20)
    const r = cpu.fns.k_parts!(hi, lo, pair(-(2 ** 20)))
    expect(val(r)).toBe(2 ** -20)
  })

  it('narrow(a) rounds to the nearest f32 — the DOCUMENTED precision loss of toF32', () => {
    // Under f32 rounding hi + lo collapses back to fround(x): narrowing IS lossy.
    expect(cpu.fns.k_narrow!(pair(1e8 + 0.5))).toBe(Math.fround(1e8 + 0.5))
  })
})

describe('df64 known answers — multiplication / division / sqrt (~48-bit results)', () => {
  it('(1 + 2^-30)² carries the 2^-29 cross term f32 drops', () => {
    const a = 1 + 2 ** -30
    const exact = a * a // 1 + 2^-29 + 2^-60 (exact in f64)
    expect(Math.fround(Math.fround(a) * Math.fround(a))).toBe(1) // f32 loses it all
    const r = val(cpu.fns.k_mul!(pair(a), pair(a)))
    expect(Math.abs(r - exact)).toBeLessThan(2 ** -45)
  })

  it('π × e to well past f32 precision', () => {
    const exact = Math.PI * Math.E
    const f32err = Math.abs(Math.fround(Math.fround(Math.PI) * Math.fround(Math.E)) - exact)
    const r = val(cpu.fns.k_mul!(pair(Math.PI), pair(Math.E)))
    const dfErr = Math.abs(r - exact)
    expect(dfErr).toBeLessThan(exact * 2 ** -44)
    expect(dfErr).toBeLessThan(f32err / 1e4) // orders of magnitude past f32
  })

  it('1 ÷ 3 to ~2^-44 relative', () => {
    const exact = 1 / 3
    const r = val(cpu.fns.k_div!(pair(1), pair(3)))
    expect(Math.abs(r - exact)).toBeLessThan(2 ** -44)
    expect(Math.abs(Math.fround(1 / 3) - exact)).toBeGreaterThan(2 ** -28)
  })

  it('√2 to ~2^-44 relative', () => {
    const r = val(cpu.fns.k_sqrt!(pair(2)))
    expect(Math.abs(r - Math.SQRT2)).toBeLessThan(2 ** -44)
    expect(Math.abs(Math.fround(Math.sqrt(2)) - Math.SQRT2)).toBeGreaterThan(2 ** -26)
  })

  it('√0 == 0 exactly (the zero guard)', () => {
    expect(cpu.fns.k_sqrt!(pair(0))).toEqual([0, 0])
  })
})

describe('df64 known answers — comparisons / selection / floor family', () => {
  it('lexicographic compare distinguishes values f32 cannot', () => {
    const a = pair(2 ** 20 + 2 ** -20)
    const b = pair(2 ** 20)
    expect(Math.fround(2 ** 20 + 2 ** -20)).toBe(2 ** 20) // f32-equal
    expect(cpu.fns.k_lt!(b, a)).toBe(1) // b < a via the lo word
    expect(cpu.fns.k_lt!(a, b)).toBe(0)
    expect(val(cpu.fns.k_min!(a, b) as CpuValue)).toBe(2 ** 20)
    expect(val(cpu.fns.k_max!(a, b) as CpuValue)).toBe(2 ** 20 + 2 ** -20)
  })

  it('abs negates the pair componentwise', () => {
    expect(val(cpu.fns.k_abs!(pair(-(1e8 + 0.5))))).toBe(1e8 + 0.5)
  })

  it('mix(a, b, 0.5) hits the midpoint at f64 resolution', () => {
    const a = 1e8,
      b = 1e8 + 1
    const r = val(cpu.fns.k_mix!(pair(a), pair(b), 0.5))
    expect(r).toBe(1e8 + 0.5)
  })

  it('floor: the lo word decides when hi is already integral', () => {
    // 2^30 + 0.5 splits as [2^30, 0.5] (0.5 < ulp(2^30)/2 in f32).
    expect(val(cpu.fns.k_floor!(pair(2 ** 30 + 0.5)))).toBe(2 ** 30)
    // Negative side: floor(−2^30 − 0.5) = −2^30 − 1.
    expect(val(cpu.fns.k_floor!(pair(-(2 ** 30) - 0.5)))).toBe(-(2 ** 30) - 1)
  })

  it('fract survives a magnitude f32 cannot hold', () => {
    expect(val(cpu.fns.k_fract!(pair(1e8 + 0.25)))).toBe(0.25)
  })
})

describe('metamorphic gate — oracle(fp64Lower(m)) ≈ oracle(m)', () => {
  // In EXACT arithmetic the EFT error terms vanish, so the lowered module must
  // reproduce the authored module's native-f64 oracle values (up to the lo·lo
  // cross terms df64 legitimately drops, ~2^-48 relative).
  const authored = compileModule(m)
  const lowered = compileModule(fp64Lower(m))

  const CASES: Array<[number, number]> = [
    [1e8 + 0.5, -1e8],
    [Math.PI, Math.E],
    [1 + 2 ** -30, 1 - 2 ** -30],
    [123456.789, 0.000123456],
    [-9876543.21, 3.14159],
  ]

  it.each(['k_add', 'k_mul', 'k_div'] as const)('%s agrees across the two paths', (name) => {
    for (const [a, b] of CASES) {
      const exact = authored.fns[name]!(a, b) as number
      const low = val(lowered.fns[name]!(pair(a), pair(b)))
      expect(Math.abs(low - exact)).toBeLessThanOrEqual(Math.abs(exact) * 2 ** -40 + 2 ** -40)
    }
  })

  it('k_sqrt agrees across the two paths', () => {
    for (const [a] of CASES) {
      const x = Math.abs(a)
      const exact = authored.fns.k_sqrt!(x) as number
      const low = val(lowered.fns.k_sqrt!(pair(x)))
      expect(Math.abs(low - exact)).toBeLessThanOrEqual(Math.abs(exact) * 2 ** -40)
    }
  })
})
