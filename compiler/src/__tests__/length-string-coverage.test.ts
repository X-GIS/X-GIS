// Pin Mapbox `["length", v]` returns codepoint count for strings.
// Pre-fix the evaluator only returned Array.length and collapsed
// string inputs to 0 — `["length", ["get", "name"]]` returned 0
// for every feature, breaking label-truncation conditionals.

import { describe, it, expect } from 'vitest'
import { evaluate } from '../eval/evaluator'
import type * as AST from '../parser/ast'

const callLength = (arg: unknown): unknown => {
  const ast: AST.FnCall = {
    kind: 'FnCall',
    callee: { kind: 'Identifier', name: 'length' } as AST.Expr,
    args: [arg as AST.Expr],
  } as AST.FnCall
  return evaluate(ast, {})
}

describe('length() string + array support', () => {
  it('length on array returns length', () => {
    const arrLit: AST.ArrayLiteral = {
      kind: 'ArrayLiteral',
      elements: [
        { kind: 'NumberLiteral', value: 1 } as AST.Expr,
        { kind: 'NumberLiteral', value: 2 } as AST.Expr,
        { kind: 'NumberLiteral', value: 3 } as AST.Expr,
      ],
    } as AST.ArrayLiteral
    expect(callLength(arrLit)).toBe(3)
  })

  it('length on ASCII string returns char count', () => {
    expect(callLength({ kind: 'StringLiteral', value: 'hello' } as AST.Expr)).toBe(5)
  })

  it('length on empty string returns 0', () => {
    expect(callLength({ kind: 'StringLiteral', value: '' } as AST.Expr)).toBe(0)
  })

  it('length on emoji string returns codepoint count, not UTF-16 units', () => {
    // '👍' is one codepoint (U+1F44D) but two UTF-16 units.
    // Mapbox spec returns 1 (the visible glyph count for BMP-outside
    // characters). The spread-array codepoint count yields 1.
    expect(callLength({ kind: 'StringLiteral', value: '👍' } as AST.Expr)).toBe(1)
  })

  it('length on non-string non-array returns 0', () => {
    expect(callLength({ kind: 'NumberLiteral', value: 42 } as AST.Expr)).toBe(0)
    expect(callLength({ kind: 'BoolLiteral', value: true } as AST.Expr)).toBe(0)
  })
})
