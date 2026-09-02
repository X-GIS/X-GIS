// ═══ Literal spelling is fail-closed on both writers (#2276) ═══
//
// Three shapes used to reach the target text as bytes no driver accepts:
//   • `-(-1.0)` spelled `--1.0` — `--` is the DECREMENT token in WGSL and GLSL;
//   • an i32/u32 literal outside its range, printed verbatim (Tint rejects it);
//   • a non-finite value, printed as `NaN` / `Infinity` (no such literal exists).
// The first is a spelling rule in the neutral walk (emit.ts unop arm); the other two
// are the writers' `literal()` refusing what the target cannot spell. Both writers are
// asserted because the spelling helpers are shared and the failure mode is silent.

import { describe, it, expect } from 'vitest'
import { emitExpr } from '../emit.js'
import { wgslBackend } from './wgsl.js'
import { glslEs300Backend } from './glsl.js'
import { f32T, i32T, u32T } from '../ir/index.js'
import type { Expr, ShaderType } from '../ir/index.js'
import { ShaderDslError } from '../diagnostics/error.js'

const lit = (value: number, type = f32T): Expr => ({ op: 'lit', type, value })
const neg = (a: Expr): Expr => ({ op: 'unop', type: a.type, uop: '-', a }) as Expr
const v = (name: string): Expr => ({ op: 'varref', type: f32T, name })
const sub = (a: Expr, b: Expr): Expr => ({ op: 'binop', type: f32T, bop: '-', a, b })

const backends = [
  ['wgsl', wgslBackend],
  ['glsl', glslEs300Backend],
] as const

describe.each(backends)('unary minus never spells `--` (%s)', (_id, be) => {
  it('negating a negative literal parenthesizes the operand, full and minimal', () => {
    expect(emitExpr(neg(lit(-1)), be)).toBe('(-(-1.0))')
    expect(emitExpr(neg(lit(-1)), be, 'minimal')).toBe('-(-1.0)')
  })
  it('a nested negation keeps its parens in both modes', () => {
    expect(emitExpr(neg(neg(v('a'))), be)).toBe('(-(-a))')
    expect(emitExpr(neg(neg(v('a'))), be, 'minimal')).toBe('-(-a)')
  })
  it('the shape inside a subtraction (the #2276 repro) contains no `--`', () => {
    for (const mode of ['full', 'minimal'] as const) {
      const s = emitExpr(sub(v('a'), neg(lit(-1))), be, mode)
      expect(s).not.toContain('--')
    }
  })
  it('a positive literal under minus is untouched', () => {
    expect(emitExpr(neg(lit(1)), be, 'minimal')).toBe('-1.0')
  })
})

describe.each(backends)('literal() is fail-closed (%s)', (_id, be) => {
  const throws = (value: number, type: ShaderType) => {
    let err: unknown
    try {
      be.literal(value, type)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ShaderDslError)
    expect((err as ShaderDslError).code).toBe('SD0017')
  }
  it('rejects i32 literals outside [-2^31, 2^31-1]', () => {
    throws(2147483648, i32T)
    throws(-2147483649, i32T)
    expect(be.literal(2147483647, i32T)).toBe('2147483647')
    expect(be.literal(-2147483648, i32T)).toBe('-2147483648')
  })
  it('rejects u32 literals outside [0, 2^32-1]', () => {
    throws(4294967296, u32T)
    throws(-1, u32T)
    expect(be.literal(4294967295, u32T)).toBe('4294967295u')
    expect(be.literal(0, u32T)).toBe('0u')
  })
  it('rejects a fractional integer literal', () => {
    throws(1.5, i32T)
    throws(1.5, u32T)
  })
  it('rejects non-finite floats and keeps finite spellings unchanged', () => {
    throws(NaN, f32T)
    throws(Infinity, f32T)
    throws(-Infinity, f32T)
    expect(be.literal(1e21, f32T)).toBe('1e+21')
    expect(be.literal(0.5, f32T)).toBe('0.5')
    expect(be.literal(2, f32T)).toBe('2.0')
  })
})
