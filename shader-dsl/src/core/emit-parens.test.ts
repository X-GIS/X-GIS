// ═══ emitExpr ParenMode — precedence, associativity, and what must stay wrapped ═══
//
// `'minimal'` omits a paren only where BOTH targets define the same precedence.
// The interesting assertions are the NEGATIVE ones: a paren that looks redundant
// and is not. Two failure modes are silent (they still compile, they just mean
// something else), so each gets a case here:
//   • REASSOCIATION — `a+(b+c)` is not `a+b+c` in floating point. The right
//     operand of an equal-precedence operator keeps its parens, always.
//   • POSTFIX BINDING — `(a*b).x` is not `a*b.x`, and `(-a)` under `-` would
//     spell `--a`, a decrement in GLSL.
// Above this, playground/e2e/_emit-obfuscate-gate.spec.ts renders the minimal
// emit through real Tint + ANGLE and compares frames byte-for-byte, so a rule
// that is wrong in a way this file did not imagine still cannot ship.

import { describe, it, expect } from 'vitest'
import { emitExpr } from './emit.js'
import { wgslBackend } from './backends/wgsl.js'
import { f32T, boolT } from './ir/index.js'
import type { Expr } from './ir/index.js'

const v = (name: string): Expr => ({ op: 'varref', type: f32T, name })
const bin = (a: Expr, bop: string, b: Expr): Expr =>
  ({ op: 'binop', type: f32T, bop, a, b }) as Expr
const neg = (a: Expr): Expr => ({ op: 'unop', type: f32T, uop: '-', a }) as Expr
const cmp = (a: Expr, cop: string, b: Expr): Expr =>
  ({ op: 'compare', type: boolT, cop, a, b }) as Expr

const min = (e: Expr): string => emitExpr(e, wgslBackend, 'minimal')
const [a, b, c] = [v('a'), v('b'), v('c')]

describe("emitExpr — 'full' (default) is unchanged", () => {
  it('wraps everything, and is what an options-free call emits', () => {
    const e = bin(bin(a, '*', b), '+', c)
    expect(emitExpr(e, wgslBackend)).toBe('((a * b) + c)')
    expect(emitExpr(e, wgslBackend, 'full')).toBe('((a * b) + c)')
  })
})

describe("emitExpr — 'minimal' drops parens precedence already implies", () => {
  it('multiplicative binds tighter than additive', () => {
    expect(min(bin(bin(a, '*', b), '+', c))).toBe('a * b + c')
    expect(min(bin(a, '+', bin(b, '*', c)))).toBe('a + b * c')
    expect(min(bin(a, '*', bin(b, '+', c)))).toBe('a * (b + c)') // …and not the other way
  })

  it('left-associates without parens, and NEVER reassociates', () => {
    expect(min(bin(bin(a, '-', b), '-', c))).toBe('a - b - c') // same parse
    expect(min(bin(a, '-', bin(b, '-', c)))).toBe('a - (b - c)') // different parse
    // The float case: `a+(b+c)` and `a+b+c` round differently, so the paren is
    // load-bearing even though `+` is mathematically associative.
    expect(min(bin(a, '+', bin(b, '+', c)))).toBe('a + (b + c)')
    expect(min(bin(a, '/', bin(b, '*', c)))).toBe('a / (b * c)')
  })

  it('unary minus takes only a primary operand', () => {
    expect(min(bin(neg(a), '*', b))).toBe('-a * b')
    expect(min(bin(a, '*', neg(b)))).toBe('a * -b')
    expect(min(neg(bin(a, '*', b)))).toBe('-(a * b)') // NOT -a * b
    expect(min(neg(neg(a)))).toBe('-(-a)') // NOT --a (a decrement in GLSL)
  })

  it('a postfix BASE keeps its parens; an argument does not need them', () => {
    const prod = bin(a, '*', b)
    expect(min({ op: 'member', type: f32T, base: prod, field: 'x' } as Expr)).toBe('(a * b).x')
    expect(min({ op: 'index', type: f32T, base: prod, idx: c } as Expr)).toBe('(a * b)[c]')
    expect(min({ op: 'call', type: f32T, fn: 'max', args: [prod, c] } as Expr)).toBe(
      'max(a * b, c)',
    )
  })

  it('an operator the two targets rank differently stays wrapped', () => {
    // WGSL makes mixing these without parens a compile ERROR rather than a
    // precedence question, so 'minimal' ranks them 0 — always wrapped — while
    // still letting their arithmetic operands unwrap.
    expect(min(cmp(bin(a, '*', b), '<', bin(a, '+', c)))).toBe('(a * b < a + c)')
    expect(min(bin(bin(a, '&', b), '|', c))).toBe('((a & b) | c)')
    expect(min(bin(bin(a, '<<', b), '+', c))).toBe('(a << b) + c')
  })
})
