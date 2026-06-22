import { describe, it, expect } from 'vitest'
import { fn, f32, f32T } from './index'
import { emitExpr } from '../backends/wgsl'

// fn() returns a callable FnHandle. Inputs can be given two ways: the TYPED object-param
// `foo({ a, b })` (TS checks names + types + completeness, autocompletes) or the loose
// positional `foo(a, b)`. The object form is mapped to declaration order at the call, so it
// produces the IDENTICAL call node — byte-identical emit, regardless of which form is used.
const add = fn('add', { a: f32T, b: f32T }, f32T, ({ a, b }) => a.add(b))

describe('fn — typed object-param call', () => {
  it('object-param maps to the same call node as positional', () => {
    expect(emitExpr(add({ a: f32(1), b: f32(2) }).expr)).toBe(emitExpr(add(f32(1), f32(2)).expr))
  })

  it('object-param uses declaration order, not key order', () => {
    // keys given b-then-a still map to positional (a, b) via the param list.
    expect(emitExpr(add({ b: f32(2), a: f32(1) }).expr)).toBe(emitExpr(add(f32(1), f32(2)).expr))
  })

  it('a single positional Node arg is NOT mistaken for an object-param', () => {
    const neg = fn('neg', { x: f32T }, f32T, ({ x }) => x.neg())
    expect(emitExpr(neg(f32(3)).expr)).toBe(emitExpr(neg({ x: f32(3) }).expr))
  })
})
