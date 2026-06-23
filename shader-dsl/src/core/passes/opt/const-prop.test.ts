import { describe, it, expect } from 'vitest'
import { constProp } from './index'
import { module, fn, f32, f32T } from '../../ir'
import { emitModule, emitFunc } from '../../backends/wgsl'
import { compileModule } from '../../oracle'

// P2 — constant propagation: substitute a literal-bound, never-reassigned local
// into its uses. Pure literal movement (no arithmetic) → bit-identical; the dead
// binding it leaves behind is DCE's job. Correctness pinned by oracle value-equality.
//
// NOTE: emitModule now runs the FULL pipeline (const-prop + const-fold + dce + …),
// so it would fold `5*2` to `10` and drop the dead `let c` — hiding the single-pass
// effect. To unit-test const-prop in ISOLATION, emit the pass's func directly via
// emitFunc (the neutral speller, no optimizer), which shows the substituted-but-
// unfolded body.
describe('optimize — constant propagation', () => {
  it('propagates a literal-bound local into its uses', () => {
    const m = module({ funcs: [fn('k', {}, f32T, (_p, b) => {
      const c = b.let('c', f32(5))
      b.ret(c.mul(2))
    })] })
    const wgsl = emitFunc(constProp(m).funcs[0]) // isolate the pass (no re-optimize)
    expect(wgsl).toMatch(/5\.0\s*\*\s*2\.0/) // c replaced by its literal 5.0
  })

  it('leaves a non-literal local alone', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, ({ x }, b) => {
      const c = b.let('c', x.add(1)) // not a literal — must NOT be propagated
      b.ret(c.mul(2))
    })] })
    expect(emitModule(constProp(m))).toMatch(/c\s*\*\s*2\.0/)
  })

  it('preserves oracle value-equality', () => {
    const m = module({ funcs: [fn('k', {}, f32T, (_p, b) => {
      const c = b.let('c', f32(5))
      b.ret(c.mul(2))
    })] })
    expect(compileModule(constProp(m)).fns.k()).toBe(compileModule(m).fns.k()) // 10
  })
})
