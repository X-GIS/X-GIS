import { describe, expect, it } from 'vitest'
import { compileModule } from './oracle'
import { module, fn, f32, f32T } from './ir'

// #13 (remaining half) — the oracle is the CPU half of a two-oracle contract; the
// GPU computes f32. Its `==` / `!=` must therefore reflect f32 rounding, not exact
// f64 equality, or it silently disagrees with the GPU on equality branches.
describe('oracle — f32-faithful equality (#13 fround compare)', () => {
  it('== returns true for two values equal after f32 rounding but unequal in f64', () => {
    // 1.0 and 1.0 + 2^-30 are distinct f64 numbers, but both round to 1.0f
    // (f32 ulp at 1.0 ≈ 1.19e-7 ≫ 2^-30 ≈ 9.3e-10). The GPU sees them equal.
    const m = module({
      funcs: [
        fn('eq1', { a: f32T, b: f32T }, f32T, (bld, { a, b }) => {
          bld.ret(a.eq(b).select(f32(1), f32(0)))
        }),
      ],
    })
    const cpu = compileModule(m)
    expect(cpu.fns.eq1(1.0, 1.0 + 2 ** -30)).toBe(1)
  })

  it('!= returns false for the same f32-equal pair', () => {
    const m = module({
      funcs: [
        fn('ne1', { a: f32T, b: f32T }, f32T, (bld, { a, b }) => {
          bld.ret(a.ne(b).select(f32(1), f32(0)))
        }),
      ],
    })
    const cpu = compileModule(m)
    expect(cpu.fns.ne1(1.0, 1.0 + 2 ** -30)).toBe(0)
  })

  it('== still distinguishes values that differ at f32 resolution', () => {
    const m = module({
      funcs: [
        fn('eq2', { a: f32T, b: f32T }, f32T, (bld, { a, b }) => {
          bld.ret(a.eq(b).select(f32(1), f32(0)))
        }),
      ],
    })
    const cpu = compileModule(m)
    expect(cpu.fns.eq2(1.0, 1.5)).toBe(0)
  })
})
