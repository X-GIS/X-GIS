import { describe, it, expect } from 'vitest'
import { module, fn, f32T, f32, optBarrier } from './index.js'
import { algebraicSimplify, constFold, fixpoint } from '../passes/opt/index.js'
import { emitModule } from '../backends/wgsl.js'
import { spellIntrinsic } from '../intrinsics.js'
import { compileModule } from '../oracle.js'

// optBarrier is C's `volatile` for one f32: value-identical, but no pass may look
// THROUGH it. Every arm below is a PAIR — the same rewrite WITHOUT the barrier (it
// fires) and WITH it (it does not). A one-sided assertion here would pass whether or
// not the barrier does anything, which is §12's "assertion that failed either way".
describe('optBarrier — the value-level optimization barrier', () => {
  const addZero = (guarded: boolean) =>
    module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.add(guarded ? optBarrier(0) : 0))
        }),
      ],
    })

  it('algebraicSimplify erases `x + 0` when it is NOT guarded', () => {
    expect(emitModule(algebraicSimplify(addZero(false)))).not.toMatch(/\+/)
  })

  it('algebraicSimplify leaves `x + optBarrier(0)` alone', () => {
    const wgsl = emitModule(algebraicSimplify(addZero(true)))
    expect(wgsl).toMatch(/\+/)
    expect(wgsl).toMatch(/bitcast<f32>\(bitcast<u32>\(/)
  })

  const litSum = (guarded: boolean) =>
    module({
      funcs: [
        fn('k', {}, f32T, (_p, b) => {
          b.ret((guarded ? optBarrier(1) : f32(1)).add(f32(2)))
        }),
      ],
    })

  it('constFold collapses `1 + 2` when it is NOT guarded', () => {
    expect(emitModule(constFold(litSum(false)))).toMatch(/3\.0/)
  })

  it('constFold cannot collapse `optBarrier(1) + 2`', () => {
    const wgsl = emitModule(constFold(litSum(true)))
    expect(wgsl).not.toMatch(/3\.0/)
    expect(wgsl).toMatch(/\+/)
  })

  // The end-to-end claim: not one pass, but the whole O2 fixpoint every backend runs.
  it('survives the full O2 fixpoint that every backend applies', () => {
    expect(emitModule(fixpoint(addZero(false)))).not.toMatch(/\+/)
    expect(emitModule(fixpoint(addZero(true)))).toMatch(/bitcast<f32>\(bitcast<u32>\(/)
  })

  it('spells as a bitcast round-trip on BOTH targets', () => {
    expect(
      spellIntrinsic('wgsl', 'bitcastF32', [spellIntrinsic('wgsl', 'bitcastU32', ['x'])]),
    ).toBe('bitcast<f32>(bitcast<u32>(x))')
    expect(
      spellIntrinsic('glsl', 'bitcastF32', [spellIntrinsic('glsl', 'bitcastU32', ['x'])]),
    ).toBe('uintBitsToFloat(floatBitsToUint(x))')
  })

  // A barrier that changed the value would be a precision bug wearing a fix's costume.
  it('is the IDENTITY on the CPU oracle', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(optBarrier(x))
        }),
      ],
    })
    const k = compileModule(m).fns.k
    for (const v of [0, 1, -1, 0.1, 1e-9, 1e8, 4097, -3.7e-12]) expect(k(v)).toBe(Math.fround(v))
  })
})
