import { describe, it, expect } from 'vitest'
import { fn, externFn, vec2, f32T, vec2fT } from './index'
import { emitFunc } from '../backends/wgsl'

// externFn is the forward-declaration ("extern") counterpart to fn(): a typed CALL-ONLY
// handle for a callee whose definition is provided elsewhere (the injection-deferred
// projection fns). Its whole contract is that an extern call emits the IDENTICAL call-by-name
// node a real fn handle would — so migrating callFn('foo', …) → foo(…) is byte-identical.
describe('externFn — typed call-only handle', () => {
  it('an extern call emits the identical node to the real fn handle call', () => {
    const real = fn('foo', { a: f32T, b: f32T }, vec2fT, ({ a, b }) => vec2(a, b))
    const ext = externFn('foo', { a: f32T, b: f32T }, vec2fT)
    const viaReal = fn('w', { x: f32T, y: f32T }, vec2fT, ({ x, y }) => real(x, y))
    const viaExt = fn('w', { x: f32T, y: f32T }, vec2fT, ({ x, y }) => ext(x, y))
    expect(emitFunc(viaExt)).toBe(emitFunc(viaReal))
  })

  it('object-param form maps to positional order identically to positional args', () => {
    const ext = externFn('foo', { a: f32T, b: f32T }, vec2fT)
    const obj = fn('w', { x: f32T, y: f32T }, vec2fT, ({ x, y }) => ext({ a: x, b: y }))
    const pos = fn('w', { x: f32T, y: f32T }, vec2fT, ({ x, y }) => ext(x, y))
    expect(emitFunc(obj)).toBe(emitFunc(pos))
  })
})
