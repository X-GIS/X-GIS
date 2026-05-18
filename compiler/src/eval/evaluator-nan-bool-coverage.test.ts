// Pin NaN-as-falsy contract for toBool (used by &&/|| short-circuit
// in the expression evaluator). Pre-fix `val !== 0` accepted NaN as
// truthy; a filter expression that evaluated to NaN bypassed the
// authored predicate and let every feature through. Mirror of the
// runtime filter-eval fix (iter 372).

import { describe, it, expect } from 'vitest'
import { evaluate } from './evaluator'
import type * as AST from '../parser/ast'

const lit = (value: number): AST.Expr =>
  ({ kind: 'NumberLiteral', value } as never)

const bool = (value: boolean): AST.Expr =>
  ({ kind: 'BoolLiteral', value } as never)

const bin = (op: '&&' | '||', left: AST.Expr, right: AST.Expr): AST.Expr =>
  ({ kind: 'BinaryExpr', op, left, right } as never)

describe('evaluator NaN-as-falsy short-circuit', () => {
  it('NaN || true → true (NaN is falsy, RHS evaluates)', () => {
    expect(evaluate(bin('||', lit(NaN), bool(true)), {})).toBe(true)
  })

  it('NaN && true → false (NaN short-circuits as false)', () => {
    expect(evaluate(bin('&&', lit(NaN), bool(true)), {})).toBe(false)
  })

  it('Infinity is also falsy', () => {
    expect(evaluate(bin('&&', lit(Infinity), bool(true)), {})).toBe(false)
  })

  it('non-zero finite number is truthy (regression guard)', () => {
    expect(evaluate(bin('&&', lit(42), bool(true)), {})).toBe(true)
  })

  it('zero is falsy (regression guard)', () => {
    expect(evaluate(bin('&&', lit(0), bool(true)), {})).toBe(false)
  })
})
