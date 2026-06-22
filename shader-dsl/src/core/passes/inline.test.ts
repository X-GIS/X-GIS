import { describe, it, expect } from 'vitest'
import { inlineFn } from './inline'
import { module, fn, f32T, callFn, type ModuleDecl } from '../ir'
import { emitModule } from '../backends/wgsl'
import { compileModule } from '../oracle'

// P4 — composition primitive: inline a single-return-expression function into its
// callers by substituting params with the call args. This is the IR-level
// composition that retires the polygon string-splice composer (placeholder/raw).
// v1 scope: single-return fns (the variant-injection shape). Pinned by oracle
// value-equality; additive (existing shaders are untouched, so byte-identity holds).
const mk = (): ModuleDecl => module({
  funcs: [
    fn('dbl', { x: f32T }, f32T, ({ x }, b) => { b.ret(x.mul(2)) }),
    fn('caller', { y: f32T }, f32T, ({ y }, b) => { b.ret(callFn('dbl', f32T, y.add(1))) }),
  ],
})

describe('inline — Fn composition (#8)', () => {
  it('inlines the call, substituting the arg (dbl(y+1) -> (y+1)*2)', () => {
    const wgsl = emitModule(inlineFn(mk(), 'dbl'))
    expect(wgsl).not.toMatch(/\bdbl\(/) // the call site is gone
  })

  it('drops the inlined fn when it is no longer called', () => {
    const wgsl = emitModule(inlineFn(mk(), 'dbl'))
    expect(wgsl).not.toContain('fn dbl')
  })

  it('preserves oracle value-equality', () => {
    const m = mk()
    expect(compileModule(inlineFn(m, 'dbl')).fns.caller(5)).toBe(compileModule(m).fns.caller(5))
  })

  it('leaves a multi-statement fn alone (v1: single-return only)', () => {
    const m = module({
      funcs: [
        fn('complex', { x: f32T }, f32T, ({ x }, b) => { const t = b.let('t', x.mul(2)); b.ret(t.add(1)) }),
        fn('caller', { y: f32T }, f32T, ({ y }, b) => { b.ret(callFn('complex', f32T, y)) }),
      ],
    })
    expect(emitModule(inlineFn(m, 'complex'))).toMatch(/\bcomplex\(/) // still called (not inlined)
  })
})
