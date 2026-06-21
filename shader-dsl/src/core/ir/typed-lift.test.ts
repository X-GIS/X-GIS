import { describe, expect, it } from 'vitest'
import { fn, f32T, u32T, i32T } from './index'
import { emitFunc } from '../backends/wgsl'

// #6 typed-arith-lift: a bare number against a u32/i32 scalar LHS lifts to that
// scalar (so `u32node.add(1)` emits `+ 1u`, not naga-invalid `+ 1.0`); every
// other LHS (the f32-dominant projection/geometry math) keeps the f32 lift.
describe('shader-dsl IR — typed arithmetic lift (#6)', () => {
  it('u32-LHS .add(1) emits an integer literal (1u), not 1.0', () => {
    const f = fn('addU', { a: u32T }, u32T, (b, p) => { b.ret(p.a.add(1)) })
    const wgsl = emitFunc(f)
    expect(wgsl).toContain('(a + 1u)')
    expect(wgsl).not.toContain('1.0')
  })

  it('i32-LHS .add(1) emits an integer literal (1i), not 1.0', () => {
    const f = fn('addI', { a: i32T }, i32T, (b, p) => { b.ret(p.a.add(1)) })
    const wgsl = emitFunc(f)
    expect(wgsl).not.toContain('1.0')
  })

  it('f32-LHS .add(1) is unchanged — still lifts to f32 (1.0)', () => {
    const f = fn('addF', { a: f32T }, f32T, (b, p) => { b.ret(p.a.add(1)) })
    const wgsl = emitFunc(f)
    expect(wgsl).toContain('(a + 1.0)')
  })

  it('f32-LHS .sub/.mul/.div/.mod(bare number) all keep the f32 lift', () => {
    const f = fn('arithF', { a: f32T }, f32T, (b, p) => {
      b.ret(p.a.sub(2).mul(3).div(4).mod(5))
    })
    const wgsl = emitFunc(f)
    expect(wgsl).toContain('2.0')
    expect(wgsl).toContain('3.0')
    expect(wgsl).toContain('4.0')
    expect(wgsl).toContain('5.0')
  })
})
