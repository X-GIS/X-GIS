import { describe, it, expect } from 'vitest'
import { constFold, fixpoint } from './index.js'
import { module, fn, f32, f32T, i32, i32T, u32, u32T, boolT, select } from '../../ir/index.js'
import { emitModule } from '../../backends/wgsl.js'
import { compileModule } from '../../oracle.js'

// P2 — constant folding of literal CONTROL predicates (the numeric +-*/ folding is
// covered by runtime/.../dsl/optimize.test.ts). A literal compare folds to a bool
// literal, a literal logical chain folds through, and a select with a literal cond
// drops its dead arm — the literals dead-branch.ts then acts on.
describe('optimize — constant folding (control predicates)', () => {
  it('folds a literal comparison: 2.0 > 1.0 -> true', () => {
    const m = module({
      funcs: [
        fn('k', {}, boolT, (_p, b) => {
          b.ret(f32(2).gt(1))
        }),
      ],
    })
    const wgsl = emitModule(constFold(m))
    expect(wgsl).toContain('true')
    expect(wgsl).not.toMatch(/2\.0\s*>\s*1\.0/)
  })

  it('folds a literal logical chain: (1>0) && (1<0) -> false', () => {
    const m = module({
      funcs: [
        fn('k', {}, boolT, (_p, b) => {
          b.ret(f32(1).gt(0).and(f32(1).lt(0)))
        }),
      ],
    })
    expect(emitModule(constFold(m))).toContain('false')
  })

  it('folds select(lit cond): select(2>1, a, b) -> a', () => {
    const m = module({
      funcs: [
        fn('k', { a: f32T, b: f32T }, f32T, ({ a, b }, bd) => {
          bd.ret(select(f32(2).gt(1), a, b))
        }),
      ],
    })
    const wgsl = emitModule(constFold(m))
    expect(wgsl).not.toContain('select')
    expect(wgsl).toMatch(/return a/)
  })

  it('preserves oracle value-equality', () => {
    const m = module({
      funcs: [
        fn('k', { a: f32T, b: f32T }, f32T, ({ a, b }, bd) => {
          bd.ret(select(f32(2).gt(1), a, b))
        }),
      ],
    })
    expect(compileModule(constFold(m)).fns.k(7, 9)).toBe(compileModule(m).fns.k(7, 9)) // 7
  })
})

// ── Integer literal folding, held to gcc 13.3 -O2 ──
//
// The expected values below are not hand-derived: each was read off `gcc -O2` for the
// equivalent C, because folding integers in JavaScript's f64 got all three of these wrong
// and two of them produced text that is not WGSL grammar at all (`3.5u`, `-1u`). The pass
// header records the full diagnosis; this is the executable half.
describe('optimize — integer literal folding matches the target, not JS f64', () => {
  const emitI = (t: typeof i32T | typeof u32T, e: unknown): string => {
    const m = module({ funcs: [fn('k', {}, t, (_p, b) => b.ret(e as never))] })
    return (emitModule(fixpoint(m)).match(/return ([^;]+);/) ?? [])[1] ?? '?'
  }

  // [name, expr, what gcc -O2 prints]
  const CASES: Array<[string, unknown, typeof i32T | typeof u32T, string]> = [
    ['i32 7 / 2 truncates', i32(7).div(i32(2)), i32T, '3'],
    ['i32 -7 / 2 truncates toward zero', i32(-7).div(i32(2)), i32T, '-3'],
    ['u32 7 / 2 truncates', u32(7).div(u32(2)), u32T, '3u'],
    ['i32 INT_MAX + 1 wraps', i32(2147483647).add(i32(1)), i32T, '-2147483648'],
    ['i32 INT_MIN - 1 wraps', i32(-2147483648).sub(i32(1)), i32T, '2147483647'],
    ['i32 100000 * 100000 wraps', i32(100000).mul(i32(100000)), i32T, '1410065408'],
    ['u32 UINT_MAX + 1 wraps to 0', u32(4294967295).add(u32(1)), u32T, '0u'],
    ['u32 0 - 1 is UINT_MAX, not -1', u32(0).sub(u32(1)), u32T, '4294967295u'],
    ['i32 -7 % 2 truncates', i32(-7).mod(i32(2)), i32T, '-1'],
    [
      'bitwise + shift literals fold',
      i32(7)
        .mod(i32(3))
        .bitOr(i32(5).bitAnd(i32(3)))
        .bitOr(i32(1).shl(4)),
      i32T,
      '17',
    ],
  ]
  for (const [name, e, t, want] of CASES) {
    it(`${name} -> ${want}`, () => expect(emitI(t, e)).toBe(want))
  }

  // The float arm must be UNTOUCHED by the integer arm: 7.0 / 2.0 is still 3.5.
  it('leaves float literal division alone (3.5, not 3)', () => {
    const m = module({ funcs: [fn('k', {}, f32T, (_p, b) => b.ret(f32(7).div(f32(2))))] })
    expect(emitModule(fixpoint(m))).toMatch(/return 3\.5;/)
  })

  it('does not fold a division by a literal zero', () => {
    const m = module({ funcs: [fn('k', {}, i32T, (_p, b) => b.ret(i32(7).div(i32(0))))] })
    expect(emitModule(fixpoint(m))).toMatch(/7 \/ 0/)
  })
})
