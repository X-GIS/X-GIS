import { describe, it, expect } from 'vitest'
import { defineFn, fn, callFn, param, f32T } from './index'
import { emitFunc, emitExpr } from '../backends/wgsl'

// #2 DX — defineFn returns a typed CALLABLE so the call site drops the string name +
// the explicit ret type: `invMercLatRad(y)` instead of `callFn('inv_merc_lat_rad',
// f32T, y)`. The const IS the function; `.decl` is the FuncDecl. Byte-identical.
describe('defineFn — typed callable (#2 DX)', () => {
  it('the call site emits identically to callFn(name, ret, ...args)', () => {
    const dbl = defineFn('dbl', { x: f32T }, f32T, ({ x }, _b) => x.mul(2))
    const arg = param('a', f32T)
    expect(emitExpr(dbl(arg).expr)).toBe(emitExpr(callFn('dbl', f32T, arg).expr))
  })

  it('.decl is the FuncDecl, emit-identical to a bare fn()', () => {
    const dbl = defineFn('dbl', { x: f32T }, f32T, ({ x }, _b) => x.mul(2))
    const bare = fn('dbl', { x: f32T }, f32T, ({ x }, _b) => x.mul(2))
    expect(dbl.decl.name).toBe('dbl')
    expect(emitFunc(dbl.decl)).toBe(emitFunc(bare))
  })
})
