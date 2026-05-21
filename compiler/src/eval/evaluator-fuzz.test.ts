// iter-293 — Expression evaluator fuzz. Sneaky inputs: NaN/Infinity
// props, mixed-type compares, deeply nested expressions, missing
// fields, recursive let, division-by-zero on field. User: "bugs
// remain — edge cases not found." Targets the surface where a real
// MVT feature could carry a value evaluator wasn't designed for.

import { describe, it, expect } from 'vitest'
import { evaluate } from './evaluator'
import type * as AST from '../parser/ast'

const num = (value: number): AST.Expr =>
  ({ kind: 'NumberLiteral', value } as AST.Expr)
const str = (value: string): AST.Expr =>
  ({ kind: 'StringLiteral', value } as AST.Expr)
const id = (name: string): AST.Expr =>
  ({ kind: 'Identifier', name } as AST.Expr)
const field = (name: string): AST.Expr =>
  ({ kind: 'FieldAccess', object: null, field: name } as AST.Expr)
const bin = (op: string, left: AST.Expr, right: AST.Expr): AST.Expr =>
  ({ kind: 'BinaryExpr', op, left, right } as AST.Expr)

describe('iter-293 evaluator fuzz — sneaky edge inputs', () => {
  it('NaN field operand: any ordered compare returns false (spec)', () => {
    const props = { x: NaN }
    expect(evaluate(bin('<', field('x'), num(5)), props)).toBe(false)
    expect(evaluate(bin('>', field('x'), num(5)), props)).toBe(false)
    expect(evaluate(bin('<=', field('x'), num(5)), props)).toBe(false)
    expect(evaluate(bin('>=', field('x'), num(5)), props)).toBe(false)
  })

  it('Infinity field operand: same rejection as NaN — non-finite returns false', () => {
    const props = { x: Infinity }
    // iter-293 fix: non-finite numeric operand rejects ordered
    // compare same as null/undefined. Consistent with toNumber's
    // defensive NaN/Infinity → 0 strip downstream.
    expect(evaluate(bin('>', field('x'), num(5)), props)).toBe(false)
    expect(evaluate(bin('<', field('x'), num(5)), props)).toBe(false)
  })

  it('Negative zero equals positive zero in == comparison', () => {
    const props = { x: -0 }
    expect(evaluate(bin('==', field('x'), num(0)), props)).toBe(true)
  })

  it('Mixed-type ordered compare returns false (per iter-536 spec)', () => {
    const props = { x: '5' }
    // string vs number → false
    expect(evaluate(bin('<', field('x'), num(6)), props)).toBe(false)
  })

  it('Missing field is null, == comparison handles null correctly', () => {
    const props = {}
    expect(evaluate(field('missing'), props)).toBe(null)
    expect(evaluate(bin('==', field('missing'), num(0)), props)).toBe(false)
  })

  it('null ?? fallback evaluates RHS', () => {
    const props = {}
    expect(evaluate(bin('??', field('missing'), num(42)), props)).toBe(42)
  })

  it('false 0 "" should NOT trigger ?? fallback (only null/undefined/NaN do)', () => {
    expect(evaluate(bin('??', num(0), num(99)), {})).toBe(0)
    expect(evaluate(bin('??', str(''), num(99)), {})).toBe('')
  })

  it('NaN value triggers ?? fallback (per Mapbox spec on non-finite numerics)', () => {
    const props = { x: NaN }
    expect(evaluate(bin('??', field('x'), num(42)), props)).toBe(42)
  })

  it('division by zero returns 0 (intentional defensive — evaluator.ts:173)', () => {
    // Design intent: rendering paint values must stay finite —
    // Infinity/NaN downstream would poison the GPU. Evaluator
    // returns 0 for both x/0 and 0/0. Style authors who want
    // explicit fallback should use `?? defaultValue`.
    expect(evaluate(bin('/', num(5), num(0)), {})).toBe(0)
    expect(evaluate(bin('/', num(0), num(0)), {})).toBe(0)
  })

  it('1000-deep nested binary expression evaluates without stack overflow', () => {
    let e: AST.Expr = num(0)
    for (let i = 0; i < 1000; i++) e = bin('+', e, num(1))
    expect(evaluate(e, {})).toBe(1000)
  })

  it('short-circuit && on false LHS skips RHS exceptions', () => {
    // RHS would divide by zero if evaluated.
    const props = { x: 0 }
    const e = bin('&&',
      bin('==', field('x'), num(1)),       // false
      bin('==', bin('/', num(1), field('x')), num(0)),  // would be 1/0=Infinity
    )
    expect(evaluate(e, props)).toBe(false)
  })

  it('short-circuit || on true LHS skips RHS', () => {
    const e = bin('||',
      bin('==', num(1), num(1)),
      bin('==', bin('/', num(1), num(0)), num(0)),
    )
    expect(evaluate(e, {})).toBe(true)
  })

  it('object value as field — chained access returns null gracefully on missing nested', () => {
    const props = { obj: { a: 1 } }
    const chain: AST.Expr = {
      kind: 'FieldAccess',
      object: { kind: 'FieldAccess', object: null, field: 'obj' } as AST.Expr,
      field: 'missing',
    } as AST.Expr
    expect(evaluate(chain, props)).toBe(null)
  })

  it('field on non-object value returns null (no crash)', () => {
    const props = { x: 42 }
    const chain: AST.Expr = {
      kind: 'FieldAccess',
      object: { kind: 'FieldAccess', object: null, field: 'x' } as AST.Expr,
      field: 'y',
    } as AST.Expr
    expect(evaluate(chain, props)).toBe(null)
  })

  it('huge string concat does not crash (10 KB)', () => {
    const big = 'a'.repeat(10000)
    const props = { s: big }
    const r = evaluate(field('s'), props)
    expect(typeof r).toBe('string')
    expect((r as string).length).toBe(10000)
  })

  it('array access with negative index returns null', () => {
    const arr: AST.Expr = {
      kind: 'ArrayLiteral',
      elements: [num(1), num(2), num(3)],
    } as AST.Expr
    const access: AST.Expr = {
      kind: 'ArrayAccess', array: arr, index: num(-1),
    } as AST.Expr
    expect(evaluate(access, {})).toBe(null)
  })

  it('array access with out-of-bounds returns null', () => {
    const arr: AST.Expr = {
      kind: 'ArrayLiteral',
      elements: [num(1), num(2)],
    } as AST.Expr
    const access: AST.Expr = {
      kind: 'ArrayAccess', array: arr, index: num(99),
    } as AST.Expr
    expect(evaluate(access, {})).toBe(null)
  })

  it('array access with fractional index floors toward 0', () => {
    const arr: AST.Expr = {
      kind: 'ArrayLiteral',
      elements: [num(10), num(20), num(30)],
    } as AST.Expr
    const access: AST.Expr = {
      kind: 'ArrayAccess', array: arr, index: num(1.7),
    } as AST.Expr
    expect(evaluate(access, {})).toBe(20)
  })

  it('array access with NaN index coerces to 0 (toNumber defensive)', () => {
    // Same defensive design as the divide path — toNumber strips
    // NaN/Infinity to 0. arr[0] returns. Documents the behavior;
    // matches the toNumber contract.
    const arr: AST.Expr = {
      kind: 'ArrayLiteral',
      elements: [num(10), num(20)],
    } as AST.Expr
    const access: AST.Expr = {
      kind: 'ArrayAccess', array: arr, index: num(NaN),
    } as AST.Expr
    expect(evaluate(access, {})).toBe(10)
  })

  // Identifier 'zoom' is a reserved key special-cased; verify missing
  // zoom returns null cleanly (not a crash).
  it('Identifier `zoom` without CAMERA_ZOOM_KEY in props returns null', () => {
    expect(evaluate(id('zoom'), {})).toBe(null)
  })
})
