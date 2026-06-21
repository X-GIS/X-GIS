import { describe, it, expect } from 'vitest'
import { optimize, constFold } from './index'
import { module, fn, f32, f32T } from '../../ir'
import { emitModule } from '../../backends/wgsl'
import { compileModule } from '../../oracle'

// P2 — the optimization pipeline (the node-graph IR's headline value: a real
// optimizing compiler, not a transliterator). Every pass is pure (module->module)
// and correctness-preserving; correctness is pinned by oracle value-equality.
describe('optimize — constant folding', () => {
  it('folds a literal-only binop: 2.0 * 3.0 -> 6.0', () => {
    const m = module({ funcs: [fn('k', {}, f32T, (b) => { b.ret(f32(2).mul(3)) })] })
    const wgsl = emitModule(constFold(m))
    expect(wgsl).toContain('6.0')
    expect(wgsl).not.toMatch(/2\.0\s*\*\s*3\.0/)
  })

  it('folds nested literals: (2+3)*4 -> 20.0', () => {
    const m = module({ funcs: [fn('k', {}, f32T, (b) => { b.ret(f32(2).add(3).mul(4)) })] })
    expect(emitModule(constFold(m))).toContain('20.0')
  })

  it('leaves a non-constant expr alone: x * 2 is preserved', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, (b, { x }) => { b.ret(x.mul(2)) })] })
    const wgsl = emitModule(constFold(m))
    expect(wgsl).toMatch(/x\s*\*\s*2\.0/)
  })

  it('preserves oracle value-equality (optimized == original)', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, (b, { x }) => { b.ret(x.add(f32(2).mul(3))) })] })
    const before = compileModule(m).fns.k(10)
    const after = compileModule(constFold(m)).fns.k(10)
    expect(after).toBe(before) // 10 + (2*3) = 16 both ways
  })

  it('optimize(m) runs the default pipeline (includes const-fold)', () => {
    const m = module({ funcs: [fn('k', {}, f32T, (b) => { b.ret(f32(2).mul(3)) })] })
    expect(emitModule(optimize(m))).toContain('6.0')
  })
})
