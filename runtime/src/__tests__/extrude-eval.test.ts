// Unit tests for the extrude expression mini-evaluator. Worker-side
// evaluator can't reuse the compiler's full evaluate() without
// dragging the lexer/parser into the worker bundle, so we maintain
// a small AST subset (NumberLiteral / FieldAccess / arithmetic
// BinaryExpr) and pin its semantics here.

import { describe, expect, it } from 'vitest'
import { evalExtrudeExpr } from '../data/extrude-eval'

const lit = (value: number) => ({ kind: 'NumberLiteral' as const, value })
const fld = (field: string) => ({ kind: 'FieldAccess' as const, object: null, field })
const bin = (op: string, left: unknown, right: unknown) =>
  ({ kind: 'BinaryExpr' as const, op, left, right })

describe('evalExtrudeExpr', () => {
  it('evaluates a NumberLiteral', () => {
    expect(evalExtrudeExpr(lit(50), {})).toBe(50)
  })

  it('reads a feature field via FieldAccess', () => {
    expect(evalExtrudeExpr(fld('height'), { height: 30 })).toBe(30)
  })

  it('returns null for missing fields', () => {
    expect(evalExtrudeExpr(fld('height'), {})).toBeNull()
  })

  it('returns null for non-numeric fields', () => {
    expect(evalExtrudeExpr(fld('name'), { name: 'tower' })).toBeNull()
  })

  it('evaluates `.levels * 3.5` (BinaryExpr *)', () => {
    expect(evalExtrudeExpr(bin('*', fld('levels'), lit(3.5)), { levels: 10 })).toBe(35)
  })

  it('evaluates `.height + 10` (BinaryExpr +)', () => {
    expect(evalExtrudeExpr(bin('+', fld('height'), lit(10)), { height: 25 })).toBe(35)
  })

  it('evaluates nested binary expressions left-to-right', () => {
    // (.levels * 3.5) + .min_height
    const ast = bin('+', bin('*', fld('levels'), lit(3.5)), fld('min_height'))
    expect(evalExtrudeExpr(ast, { levels: 4, min_height: 2 })).toBe(16)
  })

  it('returns null when any operand is missing', () => {
    expect(evalExtrudeExpr(bin('*', fld('levels'), lit(3.5)), {})).toBeNull()
  })

  it('returns null on division by zero', () => {
    expect(evalExtrudeExpr(bin('/', lit(10), lit(0)), {})).toBeNull()
  })

  it('returns null on unsupported AST kinds', () => {
    expect(evalExtrudeExpr({ kind: 'StringLiteral', value: 'oops' }, {})).toBeNull()
    expect(evalExtrudeExpr({ kind: 'FnCall' }, {})).toBeNull()
  })

  it('returns null for non-implicit FieldAccess (object !== null)', () => {
    // .feature.height — nested access not supported by miniEval
    const ast = { kind: 'FieldAccess', object: fld('feature'), field: 'height' }
    expect(evalExtrudeExpr(ast, { feature: { height: 99 } })).toBeNull()
  })
})
