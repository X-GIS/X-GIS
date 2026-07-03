import { describe, it, expect } from 'vitest'
import { emitSize, countOps, optimizerReport } from './measure'
import { module, fn, f32, f32T, sin, select } from './ir'
import { emitModule, emitModuleAt } from './backends/wgsl'

// "Measure, don't guess." The optimizer is measured on TWO axes — op count (the GPU-work
// proxy, which it minimises) and source size (the compile-time proxy, which it does NOT).
// These tests pin the honest invariant (op count is monotone non-increasing O0→O2) AND
// document the counter-intuitive truth the measurement first surfaced: CSE can GROW the
// source (a `let _cse0` line costs more bytes than the duplicate it removed) while it
// SHRINKS the op count. Bytes saved ≠ work saved.

// Redundancy = a repeated input-only subexpr. cse (O1+O2) computes sin(x) once, not twice.
const cseHeavy = module({
  funcs: [
    fn('k', { x: f32T }, f32T, ({ x }, b) => {
      b.ret(sin(x).add(sin(x)))
    }),
  ],
})

// Redundancy = a literal control predicate. Only const-fold (O2, NOT O1) collapses
// select(2>1, a, b) to `return a`, dropping the dead arm + the compare op.
const foldable = module({
  funcs: [
    fn('k', { a: f32T, b: f32T }, f32T, ({ a, b }, bd) => {
      bd.ret(select(f32(2).gt(1), a, b))
    }),
  ],
})

const trivial = module({
  funcs: [
    fn('id', { x: f32T }, f32T, ({ x }, b) => {
      b.ret(x)
    }),
  ],
})

describe('emitSize', () => {
  it('counts chars and newline-split lines', () => {
    expect(emitSize('a\nbc')).toEqual({ chars: 4, lines: 2 })
    expect(emitSize('')).toEqual({ chars: 0, lines: 1 })
  })
})

describe('countOps', () => {
  it('counts arithmetic + intrinsic-call nodes, ignores leaves', () => {
    expect(countOps(trivial)).toEqual({ calls: 0, arith: 0, total: 0 }) // `return x` — no op
    // sin(x) + sin(x): 2 calls + 1 add = 3 ops (counted on the AUTHORED module, pre-optimize)
    expect(countOps(cseHeavy)).toEqual({ calls: 2, arith: 1, total: 3 })
  })
})

describe('optimizerReport — O2 is the production emit path', () => {
  it('emitModuleAt(m, "O2") is byte-identical to emitModule(m)', () => {
    // The whole report rests on this: O2 must be the SHIPPED emit, never a measurement-only
    // variant. If this drifts, optimizerReport's o2 numbers describe a shader nobody runs.
    for (const m of [cseHeavy, foldable, trivial]) {
      expect(emitModuleAt(m, 'O2')).toBe(emitModule(m))
    }
  })
})

describe('optimizerReport — op count is the GPU-work axis (monotone non-increasing)', () => {
  it('cse removes a call (sin: 2 → 1) even though it ADDS source bytes', () => {
    const r = optimizerReport(cseHeavy)
    expect(r.ops.savedCalls).toBe(1) // sin computed once, not twice — the real win
    expect(r.ops.o2.calls).toBe(1)
    expect(r.size.savedChars).toBeLessThan(0) // …and the `let _cse0` line COSTS bytes. Bytes ≠ work.
    // ground the op count in the actual emitted WGSL: one sin call survives.
    expect((emitModule(cseHeavy).match(/sin\(/g) ?? []).length).toBe(1)
  })

  it('const-fold removes an arith op + the select, AND shrinks the source', () => {
    const r = optimizerReport(foldable)
    expect(r.ops.savedArith).toBeGreaterThanOrEqual(1) // the 2>1 compare folded away
    expect(r.size.savedChars).toBeGreaterThan(0) // dropping the dead arm shrinks source too
    expect(emitModule(foldable)).not.toContain('select')
  })

  it('invariant: the optimizer never INCREASES calls or arith for any module', () => {
    for (const m of [cseHeavy, foldable, trivial]) {
      const r = optimizerReport(m)
      expect(r.ops.o2.calls).toBeLessThanOrEqual(r.ops.o0.calls)
      expect(r.ops.o2.arith).toBeLessThanOrEqual(r.ops.o0.arith)
    }
  })
})

describe('opt levels — distinct optimization points', () => {
  it('cse fires at O1 (call dropped); fold only at O2 (predicate survives O1)', () => {
    const calls = (m: typeof cseHeavy, lvl: 'O0' | 'O1' | 'O2') =>
      (emitModuleAt(m, lvl).match(/sin\(/g) ?? []).length

    // cse module: O0 has two sin calls, O1 already dedups to one (== O2).
    expect(calls(cseHeavy, 'O0')).toBe(2)
    expect(calls(cseHeavy, 'O1')).toBe(1)
    expect(emitModuleAt(cseHeavy, 'O1')).toBe(emitModuleAt(cseHeavy, 'O2'))

    // foldable module: O1 has no const-fold so the select survives; O2 folds it away.
    expect(emitModuleAt(foldable, 'O1')).toContain('select')
    expect(emitModuleAt(foldable, 'O2')).not.toContain('select')
  })
})
