import { describe, it, expect } from 'vitest'
import { constFold } from './index'
import { module, fn, f32, f32T, boolT, select } from '../../ir'
import { emitModule } from '../../backends/wgsl'
import { compileModule } from '../../oracle'

// P2 — constant folding of literal CONTROL predicates (the numeric +-*/ folding is
// covered by runtime/.../dsl/optimize.test.ts). A literal compare folds to a bool
// literal, a literal logical chain folds through, and a select with a literal cond
// drops its dead arm — the literals dead-branch.ts then acts on.
describe('optimize — constant folding (control predicates)', () => {
  it('folds a literal comparison: 2.0 > 1.0 -> true', () => {
    const m = module({ funcs: [fn('k', {}, boolT, (_p, b) => { b.ret(f32(2).gt(1)) })] })
    const wgsl = emitModule(constFold(m))
    expect(wgsl).toContain('true')
    expect(wgsl).not.toMatch(/2\.0\s*>\s*1\.0/)
  })

  it('folds a literal logical chain: (1>0) && (1<0) -> false', () => {
    const m = module({ funcs: [fn('k', {}, boolT, (_p, b) => { b.ret(f32(1).gt(0).and(f32(1).lt(0))) })] })
    expect(emitModule(constFold(m))).toContain('false')
  })

  it('folds select(lit cond): select(2>1, a, b) -> a', () => {
    const m = module({ funcs: [fn('k', { a: f32T, b: f32T }, f32T, ({ a, b }, bd) => { bd.ret(select(f32(2).gt(1), a, b)) })] })
    const wgsl = emitModule(constFold(m))
    expect(wgsl).not.toContain('select')
    expect(wgsl).toMatch(/return a/)
  })

  it('preserves oracle value-equality', () => {
    const m = module({ funcs: [fn('k', { a: f32T, b: f32T }, f32T, ({ a, b }, bd) => { bd.ret(select(f32(2).gt(1), a, b)) })] })
    expect(compileModule(constFold(m)).fns.k(7, 9)).toBe(compileModule(m).fns.k(7, 9)) // 7
  })
})
