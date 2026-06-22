import { describe, it, expect } from 'vitest'
import { cse } from './index'
import { module, fn, f32T, sin, type Stmt, type ModuleDecl } from '../../ir'
import { emitModule } from '../../backends/wgsl'
import { compileModule } from '../../oracle'

// P2 — common-subexpression elimination (as a PASS over the IR, not an authoring
// change). Safe subset: hoist a compound subexpression that (a) occurs >= 2x and
// (b) depends only on fn inputs (params/consts/bindings, no local let) to a single
// `let` at the fn top, replacing each occurrence with a varref. A fn containing a
// raw Stmt is skipped (raw WGSL is opaque).
describe('optimize — common-subexpression elimination', () => {
  it('hoists a repeated compound subexpr into one shared temp', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, ({ x }, b) => { b.ret(sin(x).add(sin(x))) })] })
    const wgsl = emitModule(cse(m))
    expect(wgsl).toContain('_cse') // a hoisted temp was introduced
    expect((wgsl.match(/sin\(x\)/g) ?? []).length).toBe(1) // sin(x) computed once
  })

  it('does not hoist a non-repeated expr', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, ({ x }, b) => { b.ret(sin(x).add(1)) })] })
    expect(emitModule(cse(m))).not.toContain('_cse')
  })

  it('preserves oracle value-equality', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, ({ x }, b) => { b.ret(sin(x).add(sin(x))) })] })
    expect(compileModule(cse(m)).fns.k(0.5)).toBeCloseTo(compileModule(m).fns.k(0.5) as number, 10)
  })

  it('skips a fn containing a raw Stmt (does not crash, leaves it alone)', () => {
    const m: ModuleDecl = module({
      funcs: [{
        name: 'rf', params: [], ret: f32T,
        body: [{ s: 'raw', wgsl: 'return sin(1.0) + sin(1.0);' } as Stmt],
      }],
    })
    expect(() => emitModule(cse(m))).not.toThrow()
    expect(emitModule(cse(m))).not.toContain('_cse')
  })
})
