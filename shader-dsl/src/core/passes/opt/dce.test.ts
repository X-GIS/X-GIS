import { describe, it, expect } from 'vitest'
import { dce } from './index'
import { module, fn, f32, f32T, type Stmt, type ModuleDecl } from '../../ir'
import { emitModule } from '../../backends/wgsl'
import { compileModule } from '../../oracle'

// P2 — dead-code elimination: drop a local let/var whose name is never read.
// Scope: function-local bindings only (module bindings/varyings are IO/layout
// contracts, deferred to the resource model). A fn containing a raw Stmt is
// skipped (raw WGSL may reference a name DCE cannot see).
describe('optimize — dead-code elimination', () => {
  it('removes an unused let binding', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.let('dead', f32(99)) // never read
          b.ret(x.mul(2))
        }),
      ],
    })
    const wgsl = emitModule(dce(m))
    expect(wgsl).not.toContain('dead')
    expect(wgsl).not.toContain('99')
  })

  it('keeps a used let binding', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          const t = b.let('t', x.mul(2))
          b.ret(t.add(1))
        }),
      ],
    })
    expect(emitModule(dce(m))).toContain('t')
  })

  it('preserves oracle value-equality', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          b.let('dead', f32(99))
          b.ret(x.mul(2))
        }),
      ],
    })
    expect(compileModule(dce(m)).fns.k(5)).toBe(compileModule(m).fns.k(5))
  })

  it('skips a fn containing a raw Stmt (raw may reference the "dead" name)', () => {
    const m: ModuleDecl = module({
      funcs: [
        {
          name: 'rawfn',
          params: [],
          ret: f32T,
          body: [
            { s: 'let', name: 'maybe_used', expr: { op: 'lit', type: f32T, value: 1 } } as Stmt,
            { s: 'raw', wgsl: 'return maybe_used;' } as Stmt,
          ],
        },
      ],
    })
    // maybe_used is read only inside the raw string -> must NOT be dropped.
    expect(emitModule(dce(m))).toContain('maybe_used')
  })
})
