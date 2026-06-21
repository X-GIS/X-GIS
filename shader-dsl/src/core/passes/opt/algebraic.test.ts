import { describe, it, expect } from 'vitest'
import { algebraicSimplify } from './index'
import { module, fn, f32T } from '../../ir'
import { emitModule } from '../../backends/wgsl'
import { compileModule } from '../../oracle'

// P2 — algebraic simplification of IEEE-sound (for finite values) identities:
// x+0, 0+x, x-0, x*1, 1*x, x/1. x*0 -> 0 is NOT applied by default (unsound for
// Inf/NaN); it would need a fast-math flag.
describe('optimize — algebraic simplification', () => {
  it('x + 0 -> x', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, (b, { x }) => { b.ret(x.add(0)) })] })
    const wgsl = emitModule(algebraicSimplify(m))
    expect(wgsl).not.toMatch(/\+\s*0\.0/)
  })

  it('x * 1 -> x', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, (b, { x }) => { b.ret(x.mul(1)) })] })
    expect(emitModule(algebraicSimplify(m))).not.toMatch(/\*\s*1\.0/)
  })

  it('x / 1 -> x', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, (b, { x }) => { b.ret(x.div(1)) })] })
    expect(emitModule(algebraicSimplify(m))).not.toMatch(/\/\s*1\.0/)
  })

  it('does NOT apply x * 0 -> 0 by default (not IEEE-sound)', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, (b, { x }) => { b.ret(x.mul(0)) })] })
    expect(emitModule(algebraicSimplify(m))).toMatch(/\*\s*0\.0/)
  })

  it('preserves oracle value-equality', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, (b, { x }) => { b.ret(x.add(0).mul(1)) })] })
    expect(compileModule(algebraicSimplify(m)).fns.k(7)).toBe(compileModule(m).fns.k(7))
  })
})
