// ═══ f64 authoring-surface tests — the "unchanged syntax" contract ═══
//
// f64 is a first-class ShaderType: the SAME `.add/.mul/.lt/sqrt(...)` surface
// as f32, only the declared type differs. These tests pin (1) the type-level
// key plumbing, (2) binResultType's f64 rules (f64∘f64 / f64∘f32 → f64,
// everything else fail-loud), (3) literal lifting at FULL JS-double precision.

import { describe, it, expect } from 'vitest'
import {
  f64,
  f32,
  u32,
  i32,
  f64T,
  vec2,
  typeKey,
  isF64,
  sqrt,
  abs,
  min,
  toF64,
  toF32,
  type ReadonlyNode,
} from './index'

describe('f64 type plumbing', () => {
  it('typeKey / isF64 / f64T agree', () => {
    expect(typeKey(f64T)).toBe('f64')
    expect(isF64(f64T)).toBe(true)
    expect(f64(1.5).type).toEqual({ kind: 'f64' })
  })

  it('the phantom key is f64 (compile-time assignability)', () => {
    const n: ReadonlyNode<'f64'> = f64(1)
    // A key mismatch is a tsc error — an f64 node is NOT an f32 node.
    // @ts-expect-error — Node<'f64'> is not assignable to ReadonlyNode<'f32'>
    const bad: ReadonlyNode<'f32'> = f64(1)
    void n
    void bad
  })

  it('an f64 literal carries the FULL JS-double value (no eager truncation)', () => {
    const n = f64(0.1)
    expect(n.expr).toMatchObject({ op: 'lit', value: 0.1 })
    // 0.1 has no exact f32 form — the lit must NOT have been frounded.
    expect((n.expr as { value: number }).value).not.toBe(Math.fround(0.1))
  })
})

describe('binResultType f64 rules (unchanged operator syntax)', () => {
  it('f64 ∘ f64 → f64, through the ordinary methods', () => {
    const a = f64(1),
      b = f64(2)
    expect(typeKey(a.add(b).type)).toBe('f64')
    expect(typeKey(a.sub(b).type)).toBe('f64')
    expect(typeKey(a.mul(b).type)).toBe('f64')
    expect(typeKey(a.div(b).type)).toBe('f64')
    expect(typeKey(a.neg().type)).toBe('f64')
  })

  it('f64 ∘ f32 widens to f64 (both operand orders)', () => {
    expect(typeKey(f64(1).add(f32(2)).type)).toBe('f64')
    expect(typeKey(f32(2).mul(f64(1)).type)).toBe('f64')
  })

  it('a bare number lifts to an f64 literal in an f64 context — full precision', () => {
    const n = f64(1).add(0.1)
    const b = (n.expr as { b: { op: string; type: unknown; value: number } }).b
    expect(b.op).toBe('lit')
    expect(typeKey(b.type as never)).toBe('f64')
    expect(b.value).toBe(0.1)
  })

  it('f64 ∘ int / bool is rejected at author time (SD0004)', () => {
    expect(() => f64(1).add(u32(1))).toThrow(/SD0004/)
    expect(() => f64(1).mul(i32(1))).toThrow(/SD0004/)
  })

  it('f64 % has no emulation — rejected at author time (SD0041)', () => {
    expect(() => f64(1).mod(f64(2))).toThrow(/SD0041/)
  })

  it('f64 ∘ vec is rejected (no vec64 in milestone A)', () => {
    // @ts-expect-error — a vec2<f32> is not an ArithArg<'f64'>
    expect(() => f64(1).add(vec2(1, 2))).toThrow(/SD0004/)
  })

  it('bitwise on f64 is rejected (SD0005 — not a u32/i32)', () => {
    expect(() => f64(1).bitAnd(1)).toThrow(/SD0005/)
  })
})

describe('f64 comparisons and genType builtins', () => {
  it('comparisons yield bool and accept f64 / f32 / number operands', () => {
    expect(typeKey(f64(1).lt(f64(2)).type)).toBe('bool')
    expect(typeKey(f64(1).ge(f32(2)).type)).toBe('bool')
    expect(typeKey(f64(1).eq(2.5).type)).toBe('bool')
  })

  it('comparing f64 with an int is rejected (SD0004)', () => {
    expect(() => f64(1).lt(u32(2))).toThrow(/SD0004/)
  })

  it('genType builtins preserve the f64 key (sqrt/abs/min)', () => {
    const a = f64(2)
    expect(typeKey(sqrt(a).type)).toBe('f64')
    expect(typeKey(abs(a).type)).toBe('f64')
    expect(typeKey(min(a, f64(1)).type)).toBe('f64')
  })

  it('toF64 / toF32 are the explicit conversions', () => {
    expect(typeKey(toF64(f32(1)).type)).toBe('f64')
    expect(typeKey(toF32(f64(1)).type)).toBe('f32')
    // @ts-expect-error — toF64 takes f32 (narrow ints explicitly first)
    void toF64(u32(1))
  })
})
