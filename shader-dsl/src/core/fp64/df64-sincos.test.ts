// ═══ df64 sin / cos known-answer + metamorphic tests (luma.gl port) ═══
//
// The transcendental milestone's CPU gates. Same f32-rounding oracle as the
// scalar/vector suites: the ACTUAL lowered df64_sin / df64_cos IR is evaluated
// with every f32 op wrapped in Math.fround, so the reduction + Taylor bodies run
// as a correctly-rounding f32 machine would — NOT a hand mirror. Each numeric
// case carries a DISCRIMINATIVE half (plain-f32 sin/cos of the same input is far
// wrong), so a vacuous pass is impossible. Accuracy floor is the port's ~2^-36
// (the tiny-residual Taylor truncation), degrading with argument magnitude through
// the reduction; tolerances are set above the measured error with margin.
//
// What this cannot see: downstream shader-compiler fast-math collapsing the df64
// multiply (Apple/Metal). That is the real-GPU e2e's job
// (playground/e2e/_fp64-known-answer.spec.ts), device-conditional on the caveat.

import { describe, it, expect } from 'vitest'
import { fn, module, f64T, vec3f64T, sin, cos } from '../ir'
import type { Expr, ModuleDecl, ShaderType } from '../ir'
import { compileModule, type CpuValue } from '../oracle'
import { fp64Lower } from '../passes/fp64-lower'
import { mapModuleExprs } from '../passes/opt/ir-transform'
import { splitF64, DF64_TRIG_CONSTANTS } from './df64-lib'

// ── The f32-rounding oracle (identical mechanism to df64-known-answer.test.ts) ──

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

const m = module({
  funcs: [
    fn('k_sin', { a: f64T }, (p) => sin(p.a)),
    fn('k_cos', { a: f64T }, (p) => cos(p.a)),
    // vec64: sin/cos per lane, returned at full df64 precision (hi/lo planes).
    fn('v_sin', { a: vec3f64T }, (p) => sin(p.a)),
    fn('v_cos', { a: vec3f64T }, (p) => cos(p.a)),
  ],
})
const cpu = f32Oracle(m)
const pair = (x: number): number[] => splitF64(x)
const val = (r: CpuValue): number => {
  const [hi, lo] = r as number[]
  return hi! + lo!
}
const packV3 = (v: [number, number, number]): CpuValue => {
  const parts = v.map(splitF64)
  return { hi: parts.map((p) => p[0]), lo: parts.map((p) => p[1]) }
}
const dsin = (x: number): number => val(cpu.fns.k_sin!(pair(x)))
const dcos = (x: number): number => val(cpu.fns.k_cos!(pair(x)))

// ── Constants: hi + lo round-trips the double (the mis-split guard) ──

describe('df64 trig constants round-trip through the hi/lo split', () => {
  const roundTrip = (name: string, v: number): void => {
    const [hi, lo] = splitF64(v)
    // hi is the fround truncation; hi + lo reconstructs v to df64 precision.
    expect(hi, `${name}.hi`).toBe(Math.fround(v))
    const rel = v === 0 ? Math.abs(hi + lo) : Math.abs(hi + lo - v) / Math.abs(v)
    expect(rel, `${name} round-trip rel err`).toBeLessThan(2 ** -46)
    // …and materially better than the f32 hi alone (the lo word earns its keep,
    // except where v is already f32-exact — then both are exact).
    const hiRel = v === 0 ? 0 : Math.abs(hi - v) / Math.abs(v)
    if (hiRel > 0) expect(rel).toBeLessThan(hiRel)
  }
  it('scalar constants', () => {
    roundTrip('TWO_PI', DF64_TRIG_CONSTANTS.TWO_PI)
    roundTrip('PI_2', DF64_TRIG_CONSTANTS.PI_2)
    roundTrip('PI_16', DF64_TRIG_CONSTANTS.PI_16)
    roundTrip('INV_FACT_3', DF64_TRIG_CONSTANTS.INV_FACT_3)
    roundTrip('INV_FACT_4', DF64_TRIG_CONSTANTS.INV_FACT_4)
    roundTrip('INV_FACT_5', DF64_TRIG_CONSTANTS.INV_FACT_5)
    roundTrip('INV_FACT_6', DF64_TRIG_CONSTANTS.INV_FACT_6)
  })
  it('angle-addition tables (cos/sin of k·π/16, k = 1..4)', () => {
    DF64_TRIG_CONSTANTS.COS_TABLE.forEach((v, i) => roundTrip(`COS_TABLE[${i}]`, v))
    DF64_TRIG_CONSTANTS.SIN_TABLE.forEach((v, i) => roundTrip(`SIN_TABLE[${i}]`, v))
    // The tables ARE cos/sin of the intended angles (a wrong angle would silently
    // pass the round-trip but wreck sin/cos — pin the values themselves).
    for (let k = 1; k <= 4; k++) {
      expect(DF64_TRIG_CONSTANTS.COS_TABLE[k - 1]).toBe(Math.cos((k * Math.PI) / 16))
      expect(DF64_TRIG_CONSTANTS.SIN_TABLE[k - 1]).toBe(Math.sin((k * Math.PI) / 16))
    }
  })
})

// ── Scalar known answers ──

describe('df64 sin/cos known answers under f32 rounding', () => {
  it('sin(π/6) == 0.5 and cos(π/3) == 0.5 (the headline vectors)', () => {
    expect(Math.abs(dsin(Math.PI / 6) - 0.5)).toBeLessThan(1e-9)
    expect(Math.abs(dcos(Math.PI / 3) - 0.5)).toBeLessThan(1e-9)
  })

  it('exact-landing angles: sin/cos of 0, π/2, π, 3π/2', () => {
    expect(dsin(0)).toBe(0)
    expect(dcos(0)).toBe(1)
    expect(Math.abs(dsin(Math.PI / 2) - 1)).toBeLessThan(1e-9)
    expect(Math.abs(dcos(Math.PI / 2))).toBeLessThan(1e-9)
    expect(Math.abs(dsin(Math.PI))).toBeLessThan(1e-9)
    expect(Math.abs(dcos(Math.PI) + 1)).toBeLessThan(1e-9)
    expect(Math.abs(dsin((3 * Math.PI) / 2) + 1)).toBeLessThan(1e-9)
  })

  it('odd/even symmetry: sin(−x) = −sin(x), cos(−x) = cos(x)', () => {
    for (const x of [0.3, 1.1, Math.PI / 6, 2.7, 5.5]) {
      expect(Math.abs(dsin(-x) + dsin(x))).toBeLessThan(1e-12)
      expect(Math.abs(dcos(-x) - dcos(x))).toBeLessThan(1e-12)
    }
  })

  it('all four quadrants (j = 0, ±1, 2) track Math.sin/cos', () => {
    // Angles chosen to land in each reduced quadrant after the π/2 step.
    for (const x of [0.4, 1.9, 3.0, 4.4, 6.0, -2.2, -4.9]) {
      expect(Math.abs(dsin(x) - Math.sin(x)), `sin(${x})`).toBeLessThan(1e-9)
      expect(Math.abs(dcos(x) - Math.cos(x)), `cos(${x})`).toBeLessThan(1e-9)
    }
  })

  it('LARGE argument exercises the reduction — df64 is right where plain f32 is noise', () => {
    // 1e8 + 0.5 splits EXACTLY as [1e8, 0.5]; plain f32 cannot even hold the
    // argument (fround(1e8 + 0.5) = 1e8 — the 0.5 phase is gone), so its sin is
    // ~0.29 wrong. The df64 reduction keeps the 0.5 and lands the right value.
    const X = 1e8 + 0.5
    const exact = Math.sin(X)
    const got = dsin(X)
    const f32sin = Math.sin(Math.fround(X)) // what a naive f32 pipeline computes
    // df64 tracks the true value through the reduction (a few ulp of 1e8 in phase).
    expect(Math.abs(got - exact), `df64 sin(${X})`).toBeLessThan(1e-6)
    // Discriminative: plain f32 misses it by ~5 orders of magnitude more.
    expect(Math.abs(f32sin - exact)).toBeGreaterThan(0.1)
    expect(Math.abs(f32sin - exact)).toBeGreaterThan(Math.abs(got - exact) * 1e4)
    // cos too.
    expect(Math.abs(dcos(X) - Math.cos(X))).toBeLessThan(1e-6)
    expect(Math.abs(Math.cos(Math.fround(X)) - Math.cos(X))).toBeGreaterThan(0.1)
  })

  it('NEGATIVE large argument — the mod-2π turn-count nint tie convention (#922 regression)', () => {
    // When |x|/2π lands on a representable f32 half-integer (|q| ∈ [2²², 2²³), where
    // the f32 grid spacing is exactly 0.5) the mod-2π reduction's nint hits its tie.
    // luma.gl's nint rounds ties toward +∞ and df64_nint's lo-word correction is
    // ported to THAT convention; rounding the tie AWAY from zero instead double-counts
    // the correction, offsetting the turn count z by 1 — r off by 2π, a quadrant past
    // the select's ±2 arms, so the sign/swap inverts. This whole negative window was
    // silently wrong (only positive / >2²³ vectors were tested, where f32 cannot
    // represent a half-integer quotient).
    const headline = -(2 ** 22 + 0.35) * (2 * Math.PI) // measured worst 1.41 pre-fix (a full flip)
    expect(Math.abs(dsin(headline) - Math.sin(headline)), 'sin headline').toBeLessThan(1e-4)
    expect(Math.abs(dcos(headline) - Math.cos(headline)), 'cos headline').toBeLessThan(1e-4)
    // Discriminative: plain f32 cannot even hold the argument — its sine is noise.
    expect(Math.abs(Math.sin(Math.fround(headline)) - Math.sin(headline))).toBeGreaterThan(0.1)
    // Sweep the window; each q rounds to a half-integer quotient with a non-zero lo,
    // i.e. every point is the tie case the old ties-away nint got wrong.
    let worst = 0
    for (let k = 0; k < 400; k++) {
      const x = -(2 ** 22 + k * 10000 + 0.35) * (2 * Math.PI)
      worst = Math.max(worst, Math.abs(dsin(x) - Math.sin(x)), Math.abs(dcos(x) - Math.cos(x)))
    }
    expect(worst, 'negative-window sweep worst error').toBeLessThan(1e-4)
  })

  it('sin²+cos² == 1 across a sweep (the Pythagorean invariant)', () => {
    let worst = 0
    for (let i = -60; i <= 60; i++) {
      const x = i * 0.21
      const s = dsin(x)
      const c = dcos(x)
      worst = Math.max(worst, Math.abs(s * s + c * c - 1))
    }
    expect(worst).toBeLessThan(1e-9)
  })
})

// ── vec64: per-lane compose of the scalar helpers ──

describe('df64 vec64 sin/cos = scalar sin/cos per lane', () => {
  it('v_sin / v_cos match Math.sin/cos on every lane (incl. a large-arg lane)', () => {
    const lanes: [number, number, number] = [Math.PI / 6, -2.2, 1e8 + 0.5]
    const s = cpu.fns.v_sin!(packV3(lanes)) as { hi: number[]; lo: number[] }
    const c = cpu.fns.v_cos!(packV3(lanes)) as { hi: number[]; lo: number[] }
    const lane = (r: { hi: number[]; lo: number[] }, i: number): number => r.hi[i]! + r.lo[i]!
    lanes.forEach((x, i) => {
      const stol = i === 2 ? 1e-6 : 1e-9
      expect(Math.abs(lane(s, i) - Math.sin(x)), `v_sin lane ${i}`).toBeLessThan(stol)
      expect(Math.abs(lane(c, i) - Math.cos(x)), `v_cos lane ${i}`).toBeLessThan(stol)
    })
    // Lane 0 is the 0.5 headline; lane 2's plain-f32 twin is noise (non-vacuous).
    expect(Math.abs(lane(s, 0) - 0.5)).toBeLessThan(1e-9)
    expect(Math.abs(Math.sin(Math.fround(lanes[2])) - Math.sin(lanes[2]))).toBeGreaterThan(0.1)
  })
})

// ── Metamorphic gate: oracle(fp64Lower(m)) ≈ oracle(m) ──
// The native-f64 oracle evaluates authored sin/cos as JS Math.sin/cos; the lowered
// module runs the df64 emulation. In exact arithmetic they agree up to the Taylor
// truncation floor (the reduction removes it from cancellation), so the two paths
// track each other far past f32.

describe('metamorphic — authored sin/cos ≈ lowered df64 sin/cos', () => {
  const authored = compileModule(m)
  const lowered = compileModule(fp64Lower(m))
  const CASES = [0.0, 0.3, 1.0, Math.PI / 6, Math.PI / 3, 2.5, -1.7, 4.9, 6.1, -5.5]

  it('k_sin agrees with native sin across the reduced range', () => {
    for (const x of CASES) {
      const exact = authored.fns.k_sin!(x) as number
      const low = val(lowered.fns.k_sin!(pair(x)))
      expect(Math.abs(low - exact), `sin(${x})`).toBeLessThan(2 ** -30)
    }
  })
  it('k_cos agrees with native cos across the reduced range', () => {
    for (const x of CASES) {
      const exact = authored.fns.k_cos!(x) as number
      const low = val(lowered.fns.k_cos!(pair(x)))
      expect(Math.abs(low - exact), `cos(${x})`).toBeLessThan(2 ** -30)
    }
  })
})
