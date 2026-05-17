// Pin Mapbox spec: ordered comparison (< > <= >=) on strings is
// lexicographic. Pre-fix the evaluator coerced both sides via
// toNumber → "abc" / "xyz" → 0 / 0 → 0<0 = false → every ordered
// string compare returned false → symbol-sort-key emulations and
// name-based sort filters silently broke.

import { describe, it, expect } from 'vitest'
import { evaluate } from '../eval/evaluator'

// Build a BinaryExpr AST directly so the test doesn't depend on the
// public parser API surface.
function binCompare(op: '<' | '>' | '<=' | '>=', left: unknown, right: unknown): unknown {
  const lit = (v: unknown) => {
    if (typeof v === 'string') return { kind: 'StringLiteral', value: v }
    if (typeof v === 'number') return { kind: 'NumberLiteral', value: v }
    return { kind: 'NumberLiteral', value: 0 }
  }
  return evaluate(
    { kind: 'BinaryExpr', op, left: lit(left), right: lit(right) } as never,
    {},
  )
}

describe('evaluator ordered string comparison', () => {
  it('"abc" < "xyz" is true (lex)', () => {
    expect(binCompare('<', 'abc', 'xyz')).toBe(true)
  })

  it('"xyz" < "abc" is false (lex)', () => {
    expect(binCompare('<', 'xyz', 'abc')).toBe(false)
  })

  it('"abc" >= "abc" is true (lex)', () => {
    expect(binCompare('>=', 'abc', 'abc')).toBe(true)
  })

  it('numeric compare unaffected', () => {
    expect(binCompare('<', 5, 10)).toBe(true)
    expect(binCompare('<=', 10, 5)).toBe(false)
  })

  it('mixed numeric/string falls to numeric coercion (existing behavior)', () => {
    expect(binCompare('<', 'abc', 5)).toBe(true)  // 0 < 5
  })
})
