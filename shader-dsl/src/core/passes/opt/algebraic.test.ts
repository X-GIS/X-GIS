import { describe, it, expect } from 'vitest'
import { algebraicSimplify, fixpoint } from './index.js'
import { module, fn, f32T, i32T, i32, type ReadonlyNode } from '../../ir/index.js'

type NodeF = ReadonlyNode<'f32'>
type NodeI = ReadonlyNode<'i32'>
import { emitModule } from '../../backends/wgsl.js'
import { compileModule } from '../../oracle.js'

// P2 — algebraic simplification of IEEE-sound (for finite values) identities:
// x+0, 0+x, x-0, x*1, 1*x, x/1. x*0 -> 0 is NOT applied by default (unsound for
// Inf/NaN); it would need a fast-math flag.
describe('optimize — algebraic simplification', () => {
  it('x + 0 -> x', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.add(0))
        }),
      ],
    })
    const wgsl = emitModule(algebraicSimplify(m))
    expect(wgsl).not.toMatch(/\+\s*0\.0/)
  })

  it('x * 1 -> x', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.mul(1))
        }),
      ],
    })
    expect(emitModule(algebraicSimplify(m))).not.toMatch(/\*\s*1\.0/)
  })

  it('x / 1 -> x', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.div(1))
        }),
      ],
    })
    expect(emitModule(algebraicSimplify(m))).not.toMatch(/\/\s*1\.0/)
  })

  it('does NOT apply x * 0 -> 0 by default (not IEEE-sound)', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.mul(0))
        }),
      ],
    })
    expect(emitModule(algebraicSimplify(m))).toMatch(/\*\s*0\.0/)
  })

  it('preserves oracle value-equality', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.ret(x.add(0).mul(1))
        }),
      ],
    })
    expect(compileModule(algebraicSimplify(m)).fns.k(7)).toBe(compileModule(m).fns.k(7))
  })
})

// ── The identity set, held to gcc 13.3 -O2 ──
//
// Every expectation below was read off `gcc -O2` (no -ffast-math) for the equivalent C,
// so this table is a diff against a named external authority rather than against taste.
// It carries BOTH directions: what gcc folds and we now fold, and what gcc REFUSES to
// fold without -ffast-math and we must therefore also refuse. The refusals are the half
// that matters — they are the reassociation class that deletes a df64 error term.
describe('optimize — algebraic identities vs gcc -O2', () => {
  const F = (build: (x: NodeF, y: NodeF) => unknown): string => {
    const m = module({
      funcs: [fn('k', { x: f32T, y: f32T }, f32T, (p, b) => b.ret(build(p.x, p.y) as never))],
    })
    return (emitModule(fixpoint(m)).match(/return ([^;]+);/) ?? [])[1]?.replace(/\s+/g, ' ') ?? '?'
  }
  const I = (build: (i: NodeI) => unknown): string => {
    const m = module({ funcs: [fn('k', { i: i32T }, i32T, (p, b) => b.ret(build(p.i) as never))] })
    return (emitModule(fixpoint(m)).match(/return ([^;]+);/) ?? [])[1]?.replace(/\s+/g, ' ') ?? '?'
  }

  describe('folds what gcc -O2 folds', () => {
    it('x * 1.0 -> x', () => expect(F((x) => x.mul(1))).toBe('x'))
    it('x / 1.0 -> x', () => expect(F((x) => x.div(1))).toBe('x'))
    it('x / 2.0 -> x * 0.5 (exact power-of-two reciprocal)', () =>
      expect(F((x) => x.div(2))).toBe('(x * 0.5)'))
    it('x / 0.25 -> x * 4.0', () => expect(F((x) => x.div(0.25))).toBe('(x * 4.0)'))
    it('x / -2.0 -> x * -0.5 (sign rides along)', () =>
      expect(F((x) => x.div(-2))).toBe('(x * -0.5)'))
    it('-(-x) -> x', () => expect(F((x) => x.neg().neg())).toBe('x'))
    it('x - (-y) -> x + y', () => expect(F((x, y) => x.sub(y.neg()))).toBe('(x + y)'))
    it('select(c, x, x) -> x', () => expect(F((x) => x.gt(1).select(x, x))).toBe('x'))
  })

  describe('REFUSES what gcc -O2 refuses without -ffast-math', () => {
    it('keeps x * 0.0 (NaN * 0 is NaN)', () => expect(F((x) => x.mul(0))).toBe('(x * 0.0)'))
    it('keeps x - x (Inf - Inf is NaN)', () => expect(F((x) => x.sub(x))).toBe('(x - x)'))
    it('keeps x / 3.0 (1/3 is not exact)', () => expect(F((x) => x.div(3))).toBe('(x / 3.0)'))
    it('keeps x / 0.1 (1/0.1 is not exact in binary)', () =>
      expect(F((x) => x.div(0.1))).toBe('(x / 0.1)'))
  })

  describe('integer identities — sound on i32/u32, and gated so they cannot reach a float', () => {
    it('i * 0 -> 0', () => expect(I((i) => i.mul(i32(0)))).toBe('0'))
    it('i - i -> 0', () => expect(I((i) => i.sub(i))).toBe('0'))
    it('i ^ i -> 0', () => expect(I((i) => i.bitXor(i))).toBe('0'))
    it('i & i -> i', () => expect(I((i) => i.bitAnd(i))).toBe('i'))
    it('i | i -> i', () => expect(I((i) => i.bitOr(i))).toBe('i'))
    it('i & 0 -> 0', () => expect(I((i) => i.bitAnd(0))).toBe('0'))
    it('i | 0 -> i', () => expect(I((i) => i.bitOr(0))).toBe('i'))
    it('i ^ 0 -> i', () => expect(I((i) => i.bitXor(0))).toBe('i'))
    it('i << 0 -> i', () => expect(I((i) => i.shl(0))).toBe('i'))
    it('i % 1 -> 0', () => expect(I((i) => i.mod(i32(1)))).toBe('0'))

    // The gate on `intElemOf` is the load-bearing half: the same shapes on a FLOAT must
    // survive, or the pass has silently acquired -ffast-math semantics.
    it('does NOT apply the integer rules to floats', () => {
      expect(F((x) => x.mul(0))).toBe('(x * 0.0)')
      expect(F((x) => x.sub(x))).toBe('(x - x)')
    })
  })

  it('preserves oracle value-equality across the new rewrites', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T, y: f32T }, f32T, ({ x, y }, b) => {
          b.ret(x.div(4).sub(y.neg()).neg().neg())
        }),
      ],
    })
    for (const [a, c] of [
      [7, 3],
      [-1.5, 0.25],
      [1e8, -2],
    ]) {
      expect(compileModule(fixpoint(m)).fns.k!(a, c)).toBe(compileModule(m).fns.k!(a, c))
    }
  })
})
