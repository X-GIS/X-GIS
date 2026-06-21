import { describe, it, expect } from 'vitest'
import { licm } from './index'
import { module, fn, f32, f32T, i32, sin, toF32, type Stmt, type ModuleDecl } from '../../ir'
import { emitModule } from '../../backends/wgsl'
import { compileModule } from '../../oracle'

// P2 — loop-invariant code motion (a.k.a. uniform hoisting): a compound, input-only
// (params/consts/bindings, no local) expr computed inside a loop body is recomputed
// every iteration; hoist it to a single `let` before the loop. Pinned by oracle
// value-equality; a fn with a raw Stmt is skipped.
describe('optimize — loop-invariant code motion (uniform hoisting)', () => {
  it('hoists a loop-invariant input-only expr out of the loop', () => {
    const m = module({
      funcs: [fn('k', { x: f32T }, f32T, (b, { x }) => {
        const acc = b.var('acc', f32T, f32(0))
        b.forRange('i', i32(0), (i) => i.lt(i32(4)), (cb) => { cb.addAssign(acc, sin(x)) })
        b.ret(acc)
      })],
    })
    const wgsl = emitModule(licm(m))
    expect(wgsl).toContain('_licm')
    expect((wgsl.match(/sin\(x\)/g) ?? []).length).toBe(1) // computed once, hoisted out
  })

  it('does not hoist a loop-variant expr (depends on the counter)', () => {
    const m = module({
      funcs: [fn('k', {}, f32T, (b) => {
        const acc = b.var('acc', f32T, f32(0))
        b.forRange('i', i32(0), (i) => i.lt(i32(4)), (cb, i) => { cb.addAssign(acc, sin(toF32(i))) })
        b.ret(acc)
      })],
    })
    expect(emitModule(licm(m))).not.toContain('_licm')
  })

  it('preserves oracle value-equality', () => {
    const m = module({
      funcs: [fn('k', { x: f32T }, f32T, (b, { x }) => {
        const acc = b.var('acc', f32T, f32(0))
        b.forRange('i', i32(0), (i) => i.lt(i32(4)), (cb) => { cb.addAssign(acc, sin(x)) })
        b.ret(acc)
      })],
    })
    expect(compileModule(licm(m)).fns.k(0.5)).toBeCloseTo(compileModule(m).fns.k(0.5) as number, 10)
  })

  it('skips a fn containing a raw Stmt', () => {
    const m: ModuleDecl = module({
      funcs: [{ name: 'rf', params: [], ret: f32T, body: [{ s: 'raw', wgsl: 'return 1.0;' } as Stmt] }],
    })
    expect(() => emitModule(licm(m))).not.toThrow()
    expect(emitModule(licm(m))).not.toContain('_licm')
  })
})
