import { describe, it, expect } from 'vitest'
import { optimize, constFold } from '@xgis/shader-dsl/dev'
import { module, fn, f32, f32T, emitModule, compileModule } from '@xgis/shader-dsl'
import { getPROJECTION_MODULE } from './projections'

// P2 — the optimization pipeline (the node-graph IR's headline value: a real
// optimizing compiler, not a transliterator). Every pass is pure (module->module)
// and correctness-preserving; correctness is pinned by oracle value-equality.
describe('optimize — constant folding', () => {
  it('folds a literal-only binop: 2.0 * 3.0 -> 6.0', () => {
    const m = module({ funcs: [fn('k', {}, f32T, (_p, b) => { b.ret(f32(2).mul(3)) })] })
    const wgsl = emitModule(constFold(m))
    expect(wgsl).toContain('6.0')
    expect(wgsl).not.toMatch(/2\.0\s*\*\s*3\.0/)
  })

  it('folds nested literals: (2+3)*4 -> 20.0', () => {
    const m = module({ funcs: [fn('k', {}, f32T, (_p, b) => { b.ret(f32(2).add(3).mul(4)) })] })
    expect(emitModule(constFold(m))).toContain('20.0')
  })

  it('leaves a non-constant expr alone: x * 2 is preserved', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, ({ x }, b) => { b.ret(x.mul(2)) })] })
    const wgsl = emitModule(constFold(m))
    expect(wgsl).toMatch(/x\s*\*\s*2\.0/)
  })

  it('preserves oracle value-equality (optimized == original)', () => {
    const m = module({ funcs: [fn('k', { x: f32T }, f32T, ({ x }, b) => { b.ret(x.add(f32(2).mul(3))) })] })
    const before = compileModule(m).fns.k(10)
    const after = compileModule(constFold(m)).fns.k(10)
    expect(after).toBe(before) // 10 + (2*3) = 16 both ways
  })

  it('optimize(m) runs the default pipeline (includes const-fold)', () => {
    const m = module({ funcs: [fn('k', {}, f32T, (_p, b) => { b.ret(f32(2).mul(3)) })] })
    expect(emitModule(optimize(m))).toContain('6.0')
  })

  // Correctness on a REAL shader (CPU half of the differential): the full default
  // pipeline applied to the production projection module must leave compileModule
  // producing bit-identical results. (The f32 GPU half is the local
  // _shader-math-parity gate — US-11.)
  it('the default pipeline preserves oracle results on the real projection module', () => {
    const m = getPROJECTION_MODULE()
    const base = compileModule(m).fns
    const opt = compileModule(optimize(m)).fns
    for (const lon of [-170, -90, -1, 0, 45, 127, 170]) {
      for (const lat of [-80, -45, -1, 0, 30, 60, 84]) {
        const a = base.proj_mercator(lon, lat) as number[]
        const b = opt.proj_mercator(lon, lat) as number[]
        expect(b[0]).toBe(a[0])
        expect(b[1]).toBe(a[1])
      }
    }
  })
})
