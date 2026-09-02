// ═══ Generated-program differentials (#2406 · direction record D6.1) ═══
//
// Every other property test in this package randomises INPUTS over a fixed kernel. These
// randomise the KERNEL. Two differentials, neither of which needs a GPU:
//
//   A. interpreter ≡ codegen — `compileModule` and `compileModuleJs` over the SAME IR must
//      agree bit-for-bit (`Object.is`, so NaN and −0 are distinguished, not smoothed).
//   B. the optimizer preserves meaning — `oracle(pass(m)) ≡ oracle(m)`, per pass and at
//      fixpoint. O1 is asserted BIT-EXACT, which is the claim `passes/opt/optimize.ts` makes
//      in prose ("an O1 build's runtime values are bit-identical to O0's on every target")
//      and which nothing tested until now. O2 folds floats, so it gets a tolerance.
//
// (The third differential, GPU ≡ f32 oracle, waits for D2.2's f32 oracle mode.)
//
// A fuzzer that finds nothing looks exactly like a fuzzer that cannot see, so the first test
// here is the INSTRUMENT CHECK: the corpus must contain the constructs the known defects
// lived in (integer `/` and `%`, `switch` with `continue` inside a loop). Without it a
// generator that quietly stopped emitting integer division would report zero divergences
// forever and read as a clean compiler (CLAUDE.md §12).

import { describe, it, expect } from 'vitest'
import type { ShaderType, ModuleDecl } from '../ir/index.js'
import type { CpuValue } from '../cpu-runtime.js'
import { compileModule } from '../oracle.js'
import { compileModuleJs } from '../cpu-codegen.js'
import { optimizeAt, LEVEL_PASSES } from '../passes/opt/optimize.js'
import { generateModule, describeCorpus, mulberry32, type Corpus } from './random-ir.js'

const SEEDS = 24
const INPUTS_PER_FN = 10
/** Per-pass isolation is O(passes) more work, so it runs over a prefix of the corpus. The
 *  sizes here are a UNIT-TIER budget (~4 s), not a fuzzing campaign: this file's job is to
 *  keep the differentials running on every commit. Raise the seed count locally to hunt. */
const PER_PASS_SEEDS = 6

/** Seeds that have CAUGHT something, kept in the corpus forever. A sweep is free to move —
 *  the count here was trimmed once for the unit-tier budget and that alone would have
 *  dropped seed 25, the one that found #2408, silently taking the evidence with it. */
const PINNED_SEEDS = [
  25, // #2408 — CSE merged `u32(-1.0)` with `u32(-1)`; O0 16639 vs O1 255
] as const

const CORPUS: Corpus[] = [
  ...Array.from({ length: SEEDS }, (_, i) => i + 1),
  ...PINNED_SEEDS.filter((s) => s > SEEDS),
].map((s) => generateModule(s))

// ── inputs ──────────────────────────────────────────────────────────────────────────────
/** A value of `t`. Half the sweep is BOUNDARY values — 0, ±1, INT_MIN, NaN, ±Inf — because
 *  that is where wrap, `x/0` and NaN-propagation live; the rest is spread. */
function genArg(t: ShaderType, rnd: () => number, boundary: boolean): CpuValue {
  const scalar = (s: string): number => {
    if (s === 'bool') return rnd() < 0.5 ? 1 : 0
    if (s === 'i32') {
      const pool = [0, 1, -1, 2, -2147483648, 2147483647, 255, -7]
      return boundary ? pool[Math.floor(rnd() * pool.length)]! : (Math.floor(rnd() * 4e9) - 2e9) | 0
    }
    if (s === 'u32') {
      const pool = [0, 1, 2, 4294967295, 2147483648, 255]
      return boundary
        ? pool[Math.floor(rnd() * pool.length)]!
        : Math.floor(rnd() * 4294967296) >>> 0
    }
    const pool = [0, -0, 1, -1, 0.5, NaN, Infinity, -Infinity, 1e-38, 3.4e38]
    return boundary ? pool[Math.floor(rnd() * pool.length)]! : (rnd() - 0.5) * 200
  }
  if (t.kind === 'vec') return Array.from({ length: t.n }, () => scalar(t.elem)) as CpuValue
  return (t.kind === 'scalar' ? scalar(t.scalar) : 0) as CpuValue
}

/** Bit equality: `Object.is` per element, so NaN ≡ NaN and −0 ≢ +0. */
function bitEqual(a: CpuValue, b: CpuValue): boolean {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => bitEqual(v as CpuValue, b[i] as CpuValue))
  return Object.is(a, b)
}

/** Values agree to within `relTol`, with NaN ≡ NaN and same-signed Inf ≡ Inf. */
function closeEnough(a: CpuValue, b: CpuValue, relTol: number): boolean {
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length &&
      a.every((v, i) => closeEnough(v as CpuValue, b[i] as CpuValue, relTol))
    )
  if (typeof a !== 'number' || typeof b !== 'number') return Object.is(a, b)
  if (Number.isNaN(a) && Number.isNaN(b)) return true
  if (a === b) return true
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) <= relTol * Math.max(1, Math.abs(a), Math.abs(b))
}

/** Run every fn of `m` over the seeded input sweep, yielding one row per (fn, input). */
function* sweep(m: ModuleDecl): Generator<{ fn: string; args: CpuValue[]; key: string }> {
  for (const f of m.funcs) {
    const rnd = mulberry32(
      0x9e3779b9 ^ f.name.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7),
    )
    for (let k = 0; k < INPUTS_PER_FN; k++) {
      const args = f.params.map((p) => genArg(p.type, rnd, k < INPUTS_PER_FN / 2))
      yield { fn: f.name, args, key: `${f.name}(${JSON.stringify(args)})` }
    }
  }
}

const clone = (v: CpuValue[]): CpuValue[] =>
  v.map((x) => (Array.isArray(x) ? [...x] : x)) as CpuValue[]

describe('generated-program differentials (#2406)', () => {
  // ── the instrument check, FIRST: a green run below means nothing without it ──
  it('the corpus reaches the constructs the known defects lived in', () => {
    const f = describeCorpus(CORPUS)
    console.log(`[D6.1] ${SEEDS} seeds · features: ${JSON.stringify(f)}`)
    // #2274 lived in integer `/` and `%` (WGSL's `x/0 = x`, `x%0 = 0`, INT_MIN/-1 wrap).
    expect(f['int/'] ?? 0).toBeGreaterThan(20)
    expect(f['int%'] ?? 0).toBeGreaterThan(20)
    // #2275 lived in a `continue` raised inside a `switch` inside a loop.
    expect(f.switchContinue ?? 0).toBeGreaterThan(5)
    expect(f.switchBreak ?? 0).toBeGreaterThan(5)
    // and the rest of the surface the differentials claim to cover.
    for (const k of ['intShift', 'convert', 'builtin', 'select', 'for', 'if', 'callFn', 'assignOp'])
      expect(f[k] ?? 0, `corpus never generated '${k}'`).toBeGreaterThan(0)
    // and every seed that once caught a real defect is still in the corpus.
    for (const s of PINNED_SEEDS)
      expect(
        CORPUS.some((c) => c.seed === s),
        `pinned seed ${s} dropped from the corpus`,
      ).toBe(true)
  })

  it('A: the js codegen is bit-identical to the interpreter over generated programs', () => {
    const divergences: string[] = []
    let checks = 0
    for (const c of CORPUS) {
      const interp = compileModule(c.module)
      const js = compileModuleJs(c.module)
      for (const { fn, args, key } of sweep(c.module)) {
        const a = interp.fns[fn]!(...(clone(args) as never[]))
        const b = js.fns[fn]!(...(clone(args) as never[]))
        checks++
        if (!bitEqual(a, b) && divergences.length < 8)
          divergences.push(
            `seed ${c.seed} ${key}: interp=${JSON.stringify(a)} js=${JSON.stringify(b)}`,
          )
      }
    }
    console.log(`[D6.1 A] ${checks} interpreter-vs-codegen bit-equality checks`)
    expect(divergences).toEqual([])
    expect(checks).toBeGreaterThan(1000) // the sweep ran at all
  })

  it('B1: O1 is bit-exact — the claim optimize.ts:209 makes in prose', () => {
    const divergences: string[] = []
    let checks = 0
    for (const c of CORPUS) {
      const base = compileModule(c.module)
      const opt = compileModule(optimizeAt(c.module, 'O1'))
      for (const { fn, args, key } of sweep(c.module)) {
        const a = base.fns[fn]!(...(clone(args) as never[]))
        const b = opt.fns[fn]!(...(clone(args) as never[]))
        checks++
        if (!bitEqual(a, b) && divergences.length < 8)
          divergences.push(`seed ${c.seed} ${key}: O0=${JSON.stringify(a)} O1=${JSON.stringify(b)}`)
      }
    }
    console.log(`[D6.1 B1] ${checks} O0-vs-O1 bit-equality checks`)
    expect(divergences).toEqual([])
  })

  it('B2: every O1 pass preserves values in isolation', () => {
    const divergences: string[] = []
    for (const c of CORPUS.slice(0, PER_PASS_SEEDS)) {
      const base = compileModule(c.module)
      for (const pass of LEVEL_PASSES.O1) {
        const after = compileModule(pass(c.module))
        for (const { fn, args, key } of sweep(c.module)) {
          const a = base.fns[fn]!(...(clone(args) as never[]))
          const b = after.fns[fn]!(...(clone(args) as never[]))
          if (!bitEqual(a, b) && divergences.length < 8)
            divergences.push(
              `seed ${c.seed} pass#${LEVEL_PASSES.O1.indexOf(pass)} ${key}: before=${JSON.stringify(a)} after=${JSON.stringify(b)}`,
            )
        }
      }
    }
    expect(divergences).toEqual([])
  })

  // O2 adds const-folding and algebraic rewrites, so bit-equality is NOT its contract:
  // `x + 0 → x` is observable on −0.0 by design. The assertion is the numeric one; the
  // bitwise mismatch COUNT is logged rather than asserted, because it is the baseline the
  // strict-IEEE O2 decision (§7 decision 4, settled 2026-09-02) will be measured against.
  it('B3: O2 preserves values within tolerance, and its bitwise drift is recorded', () => {
    const divergences: string[] = []
    let bitwiseDrift = 0
    let checks = 0
    for (const c of CORPUS) {
      const base = compileModule(c.module)
      const opt = compileModule(optimizeAt(c.module, 'O2'))
      for (const { fn, args, key } of sweep(c.module)) {
        const a = base.fns[fn]!(...(clone(args) as never[]))
        const b = opt.fns[fn]!(...(clone(args) as never[]))
        checks++
        if (!bitEqual(a, b)) bitwiseDrift++
        if (!closeEnough(a, b, 1e-9) && divergences.length < 8)
          divergences.push(`seed ${c.seed} ${key}: O0=${JSON.stringify(a)} O2=${JSON.stringify(b)}`)
      }
    }
    console.log(
      `[D6.1 B3] ${checks} O0-vs-O2 checks · ${bitwiseDrift} bitwise-differing (within tolerance)`,
    )
    expect(divergences).toEqual([])
  })
})
