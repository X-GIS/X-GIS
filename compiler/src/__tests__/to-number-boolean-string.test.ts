// Pin iter 539 to_number / to_boolean / to_string evaluator builtins.
// Pre-fix the evaluator had no handlers for these; the `default:
// return args[0] ?? null` branch returned the input unchanged so
// `to_number("abc")` returned the STRING "abc" — silently breaking
// strict-equality comparisons that followed.
//
// In practice the Mapbox converter strips `["to-number", v]` to a
// bare `v` (or coalesce chain) so these builtins rarely fire on
// OFM-derived xgis source. They still need to work for hand-authored
// xgis source and for any future converter that preserves the type-
// conversion intent.

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { evaluate } from '../eval/evaluator'
import { makeEvalProps } from '../eval/reserved-keys'

function evalExpr(src: string, props: Record<string, unknown> = {}): unknown {
  const tokens = new Lexer('let __x = ' + src).tokenize()
  const ast = new Parser(tokens).parse()
  const stmt = ast.body[0]
  if (stmt.kind !== 'LetStatement') throw new Error('expected LetStatement')
  return evaluate(stmt.value as never, makeEvalProps({ props }))
}

describe('to_number — Mapbox spec coercion (iter 539)', () => {
  it('"5" → 5', () => {
    expect(evalExpr('to_number("5")')).toBe(5)
  })

  it('"3.14" → 3.14', () => {
    expect(evalExpr('to_number("3.14")')).toBe(3.14)
  })

  it('"abc" → null (non-numeric string)', () => {
    expect(evalExpr('to_number("abc")')).toBeNull()
  })

  it('"abc" with fallback 7 → 7', () => {
    expect(evalExpr('to_number("abc", 7)')).toBe(7)
  })

  it('"abc" with "5" fallback → 5 (chain of conversions)', () => {
    expect(evalExpr('to_number("abc", "5")')).toBe(5)
  })

  it('null → null', () => {
    expect(evalExpr('to_number(null)')).toBeNull()
  })

  it('true → 1, false → 0', () => {
    expect(evalExpr('to_number(true)')).toBe(1)
    expect(evalExpr('to_number(false)')).toBe(0)
  })

  it('finite number unchanged', () => {
    expect(evalExpr('to_number(42)')).toBe(42)
  })

  it('all-null args → null', () => {
    expect(evalExpr('to_number(null, null)')).toBeNull()
  })
})

describe('to_string — Mapbox spec coercion (iter 539)', () => {
  it('5 → "5"', () => {
    expect(evalExpr('to_string(5)')).toBe('5')
  })

  it('null → ""', () => {
    expect(evalExpr('to_string(null)')).toBe('')
  })

  it('true → "true"', () => {
    expect(evalExpr('to_string(true)')).toBe('true')
  })

  it('"abc" → "abc"', () => {
    expect(evalExpr('to_string("abc")')).toBe('abc')
  })
})

describe('to_boolean — Mapbox spec coercion (iter 539)', () => {
  it('0 → false', () => {
    expect(evalExpr('to_boolean(0)')).toBe(false)
  })

  it('1 → true', () => {
    expect(evalExpr('to_boolean(1)')).toBe(true)
  })

  it('"" → false', () => {
    expect(evalExpr('to_boolean("")')).toBe(false)
  })

  it('"abc" → true', () => {
    expect(evalExpr('to_boolean("abc")')).toBe(true)
  })

  it('null → false', () => {
    expect(evalExpr('to_boolean(null)')).toBe(false)
  })

  it('true / false unchanged', () => {
    expect(evalExpr('to_boolean(true)')).toBe(true)
    expect(evalExpr('to_boolean(false)')).toBe(false)
  })
})

describe('to_color — Mapbox spec coercion (iter 541)', () => {
  it('"#fff" → "#fff"', () => {
    expect(evalExpr('to_color("#fff")')).toBe('#fff')
  })

  it('"#abcdef" → "#abcdef"', () => {
    expect(evalExpr('to_color("#abcdef")')).toBe('#abcdef')
  })

  it('"#abcd" → "#abcd" (4-digit RGBA)', () => {
    expect(evalExpr('to_color("#abcd")')).toBe('#abcd')
  })

  it('"#abcdef12" → "#abcdef12" (8-digit RRGGBBAA)', () => {
    expect(evalExpr('to_color("#abcdef12")')).toBe('#abcdef12')
  })

  it('"not-a-color" → null', () => {
    expect(evalExpr('to_color("not-a-color")')).toBeNull()
  })

  it('"red" (CSS name, not hex) → null (X-GIS hex-only validation)', () => {
    // Mapbox accepts CSS names; X-GIS represents colours as hex
    // strings so the converter pre-resolves names → hex. The
    // evaluator's to_color enforces hex-only validity.
    expect(evalExpr('to_color("red")')).toBeNull()
  })

  it('null → null (no valid color, no fallback)', () => {
    expect(evalExpr('to_color(null)')).toBeNull()
  })

  it('number 5 → null', () => {
    expect(evalExpr('to_color(5)')).toBeNull()
  })

  it('"not-a-color" with fallback "#fff" → "#fff"', () => {
    expect(evalExpr('to_color("not-a-color", "#fff")')).toBe('#fff')
  })

  it('"#xyz" (invalid hex) → null', () => {
    expect(evalExpr('to_color("#xyz")')).toBeNull()
  })

  it('"#12345" (5-char, invalid) → null', () => {
    // CSS Color Module 4: only 3/4/6/8 hex digits valid
    expect(evalExpr('to_color("#12345")')).toBeNull()
  })
})
