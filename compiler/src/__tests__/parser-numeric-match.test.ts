// Numeric match() labels round-trip. The Mapbox->xgis converter emits
// numeric match keys as BARE numbers (convert/expressions.ts:352), e.g.
// `match(.cls) { 1 -> 100, _ -> 999 }`, and that output is re-parsed in
// production (ir/lower-helpers.ts, module/resolver.ts). Pre-fix the parser
// only accepted String/Identifier arm patterns, so the lexed Number token
// fell into `else { break }` and the trailing expect(RBrace) threw
// `[Parser] Expected RBrace, got Number ('1')`. These tests pin the
// convert -> parse -> evaluate path end to end so the regression can't
// silently return.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'
import { parseExpressionString } from '../parser/parser'
import { evaluate } from '../eval/evaluator'

describe('parser: numeric match() labels', () => {
  it('positive numeric key round-trips convert -> parse -> eval', () => {
    const xg = exprToXgis(['match', ['get', 'rank'], 1, 'a', 2, 'b', 'fallback'], [])
    expect(xg).not.toBeNull()
    const ast = parseExpressionString(xg!)
    expect(evaluate(ast, { rank: 2 })).toBe('b')
    expect(evaluate(ast, { rank: 1 })).toBe('a')
    expect(evaluate(ast, { rank: 99 })).toBe('fallback')
  })

  it('negative numeric key round-trips (Minus + Number)', () => {
    const xg = exprToXgis(['match', ['get', 'delta'], -3, 'neg', 5, 'pos', 'fb'], [])
    expect(xg).not.toBeNull()
    const ast = parseExpressionString(xg!)
    expect(evaluate(ast, { delta: -3 })).toBe('neg')
    expect(evaluate(ast, { delta: 5 })).toBe('pos')
    expect(evaluate(ast, { delta: 0 })).toBe('fb')
  })

  it('parses a direct numeric-key match string without throwing', () => {
    const ast = parseExpressionString('match(.c) { 1 -> 10, _ -> 0 }')
    expect(evaluate(ast, { c: 1 })).toBe(10)
    expect(evaluate(ast, { c: 7 })).toBe(0)
  })
})
