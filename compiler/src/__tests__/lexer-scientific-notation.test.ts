// Iter 542 — lexer scientific-notation support. Pre-fix the lexer
// stopped after the decimal block in `readNumber()`. `1.5e3` lexed
// as (Number 1.5, Identifier "e3") and downstream evaluators saw the
// `e3` as a free-standing identifier returning 0 / null. JSON encodes
// extreme magnitudes in scientific (JSON.stringify(1e22) → "1e+22");
// any Mapbox-source style with such a value would silently parse to
// the mantissa only.

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { evaluate } from '../eval/evaluator'
import { makeEvalProps } from '../eval/reserved-keys'
import { withPragma } from './_pragma'

function evalNum(src: string): unknown {
  // Only the parse-path helper needs the pragma; the two bare-token
  // assertions below call `new Lexer(...).tokenize()` directly (no parse)
  // and MUST stay pragma-free so `tokens[0]` is the number under test.
  const tokens = new Lexer(withPragma('let __x = ' + src)).tokenize()
  const ast = new Parser(tokens).parse()
  const stmt = ast.body[0]
  if (stmt.kind !== 'LetStatement') throw new Error('expected LetStatement')
  return evaluate(stmt.value as never, makeEvalProps({}))
}

describe('lexer scientific notation (iter 542)', () => {
  it('1e3 → 1000', () => {
    expect(evalNum('1e3')).toBe(1000)
  })

  it('1E3 → 1000 (uppercase E)', () => {
    expect(evalNum('1E3')).toBe(1000)
  })

  it('1.5e2 → 150', () => {
    expect(evalNum('1.5e2')).toBe(150)
  })

  it('2e-3 → 0.002 (negative exponent)', () => {
    expect(evalNum('2e-3')).toBe(0.002)
  })

  it('2e+3 → 2000 (explicit positive sign)', () => {
    expect(evalNum('2e+3')).toBe(2000)
  })

  it('6.022e23 → Avogadro', () => {
    expect(evalNum('6.022e23')).toBe(6.022e23)
  })

  it('1e-7 → 1e-7 (JSON.stringify small-number scientific)', () => {
    expect(evalNum('1e-7')).toBe(1e-7)
  })

  it('1e308 * 2 → Infinity → 0 (finite() clamp)', () => {
    // Real overflow gets caught by the evaluator's finite() guard.
    // Pre-fix `1e308` parsed as `1` so this returned 1.7 etc.
    expect(evalNum('1e308 * 2')).toBe(0)
  })

  it('arithmetic with scientific operands works', () => {
    expect(evalNum('1e3 + 1e2')).toBe(1100)
    expect(evalNum('2e2 * 3')).toBe(600)
  })

  it('does NOT consume "e" without trailing digit (e.g. `1.5em`-style)', () => {
    // Future-proofing: if `em` were added to UNITS, `1.5em` must lex
    // as number(1.5) + unit(em), not number(1.5e) + identifier(m).
    // The exponent gate requires a digit (with optional sign) after
    // the `e`; bare `e` followed by alpha skips the exponent branch.
    const tokens = new Lexer('1.5e').tokenize()
    // First token: Number value 1.5 (no exponent consumed)
    expect(tokens[0]?.value).toBe('1.5')
  })

  it('does NOT consume sign as exponent when no digit follows', () => {
    // `1.5e+` (no exponent digit) → number 1.5 + identifier "e" + ...
    // The exponent gate must require at least one digit after the
    // optional sign.
    const tokens = new Lexer('1.5e+ 7').tokenize()
    expect(tokens[0]?.value).toBe('1.5')
  })

  it('integer mantissa + exponent (no decimal): 5e2 → 500', () => {
    expect(evalNum('5e2')).toBe(500)
  })

  it('chained ops respect operator precedence', () => {
    // 2 * 3e2 = 600 (not parsed as 2 * 3 followed by e2)
    expect(evalNum('2 * 3e2')).toBe(600)
  })
})
