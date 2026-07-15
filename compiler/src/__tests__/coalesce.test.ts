// `??` operator parsing + evaluation. User reported `.height ?? 50`
// wasn't accepted by the language; this spec locks it in.

import { describe, it, expect } from 'vitest'
import { evaluate } from '../eval/evaluator'
import { parseExpressionString } from '../parser/parser'

function parseExpr(src: string): unknown {
  return parseExpressionString(src)
}

function evalExpr(src: string, props: Record<string, unknown> = {}): unknown {
  const expr = parseExpr(src) as never
  return evaluate(expr, props)
}

describe('?? (nullish coalesce)', () => {
  it('returns LHS when LHS is non-null', () => {
    expect(evalExpr('5 ?? 10')).toBe(5)
    expect(evalExpr('"a" ?? "b"')).toBe('a')
  })

  it('returns RHS when LHS is null / undefined', () => {
    // .field on missing prop returns undefined → fallback fires.
    expect(evalExpr('.height ?? 50', { other: 1 })).toBe(50)
  })

  it('returns LHS=0 (preserves explicit zero)', () => {
    // The whole point of `??` over `||`: 0 is a valid value, not
    // a fallback trigger.
    expect(evalExpr('.height ?? 50', { height: 0 })).toBe(0)
  })

  it('returns RHS when LHS is non-finite number', () => {
    expect(evalExpr('.height ?? 50', { height: NaN })).toBe(50)
  })

  it('chains right-to-left', () => {
    expect(evalExpr('.a ?? .b ?? 99', { b: 7 })).toBe(7)
    expect(evalExpr('.a ?? .b ?? 99', {})).toBe(99)
  })

  it('binds tighter than ternary, looser than ||', () => {
    // `.h ?? 5` evaluates first, then ternary on `true ? ... : ...`
    expect(evalExpr('true ? .h ?? 5 : 99', {})).toBe(5)
    // `||` binds tighter: `(.flag || .other) ?? 7`
    expect(evalExpr('.flag || .other ?? 7', { flag: false, other: 0 })).toBe(false)
  })
})
