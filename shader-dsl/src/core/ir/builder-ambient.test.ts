import { describe, it, expect } from 'vitest'
import {
  fn, Let, Var, If, Loop, Continue, Return, assign, addAssign,
  f32, f32T, i32, bool,
} from './index'
import { emitFunc } from '../backends/wgsl'

// C2 — the ambient current-builder stack: `If`/`Loop`/`Let`/`assign`/… are free
// functions over the innermost active scope, so authoring no longer threads a
// `Builder` param per nesting level (the cb→d→cb2→e proliferation that caused the
// documented line.ts:721-726 shadowing bug). It is a PURE authoring-surface change:
// the emitted IR must be byte-identical to the old passed-builder style.
describe('builder — ambient free-function style (C2)', () => {
  it('emits byte-identical WGSL to the old passed-builder style', () => {
    const old = fn('k', { x: f32T }, f32T, (b, { x }) => {
      const a = b.let('a', x.mul(2))
      const acc = b.var('acc', f32T, f32(0))
      b.forRange('i', i32(0), (i) => i.lt(i32(3)), (cb, i) => {
        cb.addAssign(acc, a)
        cb.if(i.eq(i32(1)), (d) => { d.assign(acc, a) })
      })
      b.ret(acc)
    })
    const neo = fn('k', { x: f32T }, f32T, (_b, { x }) => {
      const a = Let('a', x.mul(2))
      const acc = Var('acc', f32T, f32(0))
      Loop('i', i32(0), (i) => i.lt(i32(3)), (i) => {
        addAssign(acc, a)
        If(i.eq(i32(1)), () => { assign(acc, a) })
      })
      Return(acc)
    })
    expect(emitFunc(neo)).toBe(emitFunc(old))
  })

  it('Continue() targets the innermost loop (the shadowing bug is unrepresentable)', () => {
    const f = fn('k', {}, f32T, () => {
      const acc = Var('acc', f32T, f32(0))
      Loop('i', i32(0), (i) => i.lt(i32(3)), (i) => {
        If(i.eq(i32(1)), () => Continue())
        addAssign(acc, f32(1))
      })
      Return(acc)
    })
    // the continue sits inside the if inside the for — not a stray top-level continue.
    expect(emitFunc(f)).toMatch(/for[\s\S]*if[\s\S]*continue/)
  })

  it('a native `return value` body emits identically to b.ret(value)', () => {
    const old = fn('k', { x: f32T }, f32T, (b, { x }) => { b.ret(x.mul(2)) })
    const neo = fn('k', { x: f32T }, f32T, (_b, { x }) => x.mul(2)) // native TS return
    expect(emitFunc(neo)).toBe(emitFunc(old))
  })

  it('native return composes with ambient Let', () => {
    const old = fn('k', { x: f32T }, f32T, (b, { x }) => { const t = b.let('t', x.mul(2)); b.ret(t.add(1)) })
    const neo = fn('k', { x: f32T }, f32T, (_b, { x }) => { const t = Let('t', x.mul(2)); return t.add(1) })
    expect(emitFunc(neo)).toBe(emitFunc(old))
  })

  it('the ambient stack is exception-safe — a throw mid-If leaves it clean', () => {
    expect(() => fn('bad', {}, f32T, () => { If(bool(true), () => { throw new Error('boom') }) })).toThrow('boom')
    // after the throw, a fresh fn must still author + emit (stack not corrupted).
    const ok = fn('ok', {}, f32T, () => { Return(f32(7)) })
    expect(emitFunc(ok)).toContain('return 7.0')
  })
})
