import { describe, it, expect } from 'vitest'
import { copyProp } from './index'
import { module, fn, f32T } from '../../ir'
import { emitModule } from '../../backends/wgsl'
import { compileModule } from '../../oracle'

// P2 — copy propagation: substitute a bare copy binding (let y = x, no
// computation) into its uses when neither side is reassigned. Pure reference
// renaming → bit-identical. Correctness pinned by oracle value-equality.
describe('optimize — copy propagation', () => {
  it('propagates a copy binding (let y = x) into its uses', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, ({ x }, b) => {
      const y = b.let('y', x)
      b.ret(y.add(1))
    })] })
    const wgsl = emitModule(copyProp(m))
    expect(wgsl).toMatch(/x\s*\+\s*1\.0/) // y replaced by x
  })

  it('preserves oracle value-equality', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, ({ x }, b) => {
      const y = b.let('y', x)
      b.ret(y.add(1))
    })] })
    expect(compileModule(copyProp(m)).fns.k(4)).toBe(compileModule(m).fns.k(4)) // 5
  })
})
