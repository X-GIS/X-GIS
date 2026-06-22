import { describe, it, expect } from 'vitest'
import { fn, Let, Var, If, Return, f32, f32T } from './index'
import { emitFunc } from '../backends/wgsl'

// Optional binding names (v2 item 2): `let`/`var` accept NO name and synthesize a
// function-unique `_v{n}`. The motivation is the redundancy in `const lon = Let('lon', e)`
// — the JS const already carries the meaning. The tradeoff is an opaque WGSL name, so
// existing call sites keep their explicit names (byte-identical); this only adds the
// capability. The counter is function-scoped + deterministic, which the WGSL snapshot
// gates require.
describe('auto-named bindings — optional name', () => {
  it('Let(value) emits a deterministic auto name and the varref resolves to it', () => {
    const f = fn('k', { x: f32T }, f32T, ({ x }) => {
      const a = Let(x.mul(2)) // no name
      return a.add(1)
    })
    const wgsl = emitFunc(f)
    expect(wgsl).toContain('let _v0 = ')
    expect(wgsl).toMatch(/return \(_v0 \+/) // the captured varref carries the auto name
  })

  it('the counter increments per binding within a function', () => {
    const f = fn('k', { x: f32T }, f32T, ({ x }) => {
      const a = Let(x.mul(2))
      const b = Let(a.add(1))
      return b
    })
    const wgsl = emitFunc(f)
    expect(wgsl).toContain('let _v0 = ')
    expect(wgsl).toContain('let _v1 = ')
  })

  it('nested scopes SHARE the counter — an inner auto-name never shadows an outer one', () => {
    const f = fn('k', { x: f32T }, f32T, ({ x }) => {
      const a = Let(x.mul(2)) // _v0
      If(x.gt(f32(0)), () => {
        const inner = Let(a.add(1)) // _v1 — a per-block counter would emit _v0 again and
        Return(inner) //               shadow `a`, mis-resolving the outer binding's varref
      })
      return a
    })
    const wgsl = emitFunc(f)
    expect(wgsl).toContain('let _v0 = ')
    expect(wgsl).toContain('let _v1 = ')
    // exactly ONE _v0 binding exists (the outer one) — no inner shadow
    expect(wgsl.match(/let _v0 =/g)?.length).toBe(1)
  })

  it('explicit names are unchanged — auto form differs only in the binding name', () => {
    const auto = fn('k', { x: f32T }, f32T, ({ x }) => Let(x.mul(2)).add(1))
    const named = fn('k', { x: f32T }, f32T, ({ x }) => Let('t', x.mul(2)).add(1))
    expect(emitFunc(named)).toContain('let t = ')
    expect(emitFunc(named)).not.toContain('_v0')
    expect(emitFunc(auto).replace(/_v0/g, 't')).toBe(emitFunc(named))
  })

  it('Var(type, init?) auto-names too', () => {
    const f = fn('k', {}, f32T, () => {
      const acc = Var(f32T, f32(0))
      return acc
    })
    expect(emitFunc(f)).toContain('var _v0')
  })

  it('auto names are deterministic across rebuilds (counter resets per fn)', () => {
    const make = () =>
      fn('k', { x: f32T }, f32T, ({ x }) => {
        const a = Let(x.mul(2))
        return a.add(Let(x.mul(3)))
      })
    expect(emitFunc(make())).toBe(emitFunc(make()))
  })
})
