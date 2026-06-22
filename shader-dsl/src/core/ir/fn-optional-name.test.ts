import { describe, it, expect } from 'vitest'
import { fn, f32T } from './index'
import { emitFunc } from '../backends/wgsl'

// fn()'s name is OPTIONAL (the redundant-with-the-JS-const string): omit it for an auto
// `_fn{n}`. The name flows through the handle, so the decl AND every call use the same auto
// name — consistent without a string reference. (Keep an explicit name for string-referenced
// / snapshot-tested / re-authored fns — see the fnAutoId caveat.) The body's native return is
// also type-checked against the ret type now; that is a compile-time guarantee (a wrong-typed
// return is a tsc error), exercised by the suite compiling at all.
describe('fn — optional name', () => {
  it('omitting the name synthesizes an auto _fn{n} and the fn stays callable', () => {
    const f = fn({ x: f32T }, f32T, ({ x }) => x.mul(2))
    expect(f.name).toMatch(/^_fn\d+$/)
    expect(emitFunc(f)).toMatch(/^fn _fn\d+\(x: f32\) -> f32 \{/)
    // a caller emits a call-by-name to that same auto name (handle carries it)
    const caller = fn('c', { y: f32T }, f32T, ({ y }) => f(y))
    expect(emitFunc(caller)).toContain(`${f.name}(y)`)
  })

  it('an explicit name is unchanged', () => {
    const named = fn('foo', { x: f32T }, f32T, ({ x }) => x.mul(2))
    expect(named.name).toBe('foo')
    expect(emitFunc(named)).toContain('fn foo(x: f32)')
  })
})
