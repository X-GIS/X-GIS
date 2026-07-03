// iter-310 — Evaluator builtin + AST-kind coverage. iter-293 fuzz
// targeted BinaryExpr only; mutation testing (iter-309) reported
// evaluator at 13 % because match / pipe / conditional / array /
// every builtin path was unexercised. These tests pin each
// builtin's contract with an EXACT-output equality assertion (the
// shape that actually kills mutants per the iter-306 insight).

import { describe, it, expect } from 'vitest'
import { evaluate } from './evaluator'
import { CAMERA_ZOOM_KEY } from './reserved-keys'
import type * as AST from '../parser/ast'

const num = (value: number): AST.Expr => ({ kind: 'NumberLiteral', value }) as AST.Expr
const str = (value: string): AST.Expr => ({ kind: 'StringLiteral', value }) as AST.Expr
const bool = (value: boolean): AST.Expr => ({ kind: 'BoolLiteral', value }) as AST.Expr
const field = (name: string): AST.Expr =>
  ({ kind: 'FieldAccess', object: null, field: name }) as AST.Expr
const id = (name: string): AST.Expr => ({ kind: 'Identifier', name }) as AST.Expr
const call = (name: string, ...args: AST.Expr[]): AST.Expr =>
  ({ kind: 'FnCall', callee: { kind: 'Identifier', name }, args }) as AST.Expr
const arr = (...elements: AST.Expr[]): AST.Expr => ({ kind: 'ArrayLiteral', elements }) as AST.Expr
const cond = (c: AST.Expr, t: AST.Expr, e: AST.Expr): AST.Expr =>
  ({ kind: 'ConditionalExpr', condition: c, thenExpr: t, elseExpr: e }) as AST.Expr

describe('iter-310 evaluator builtins — exact output pins', () => {
  it('clamp', () => {
    expect(evaluate(call('clamp', num(15), num(0), num(10)), {})).toBe(10)
    expect(evaluate(call('clamp', num(-5), num(0), num(10)), {})).toBe(0)
    expect(evaluate(call('clamp', num(5), num(0), num(10)), {})).toBe(5)
  })

  it('min / max — multi-arg', () => {
    expect(evaluate(call('min', num(3), num(1), num(2)), {})).toBe(1)
    expect(evaluate(call('max', num(3), num(1), num(2)), {})).toBe(3)
  })

  it('min / max — empty args → 0 (non-finite guard)', () => {
    expect(evaluate(call('min'), {})).toBe(0)
    expect(evaluate(call('max'), {})).toBe(0)
  })

  it('round / floor / ceil', () => {
    expect(evaluate(call('round', num(2.5)), {})).toBe(3)
    expect(evaluate(call('round', num(2.4)), {})).toBe(2)
    expect(evaluate(call('floor', num(2.9)), {})).toBe(2)
    expect(evaluate(call('ceil', num(2.1)), {})).toBe(3)
  })

  it('abs', () => {
    expect(evaluate(call('abs', num(-7)), {})).toBe(7)
    expect(evaluate(call('abs', num(7)), {})).toBe(7)
  })

  it('sqrt — negative clamps to 0', () => {
    expect(evaluate(call('sqrt', num(9)), {})).toBe(3)
    expect(evaluate(call('sqrt', num(-4)), {})).toBe(0)
  })

  it('scale = a × b', () => {
    expect(evaluate(call('scale', num(3), num(4)), {})).toBe(12)
  })

  it('concat — coerces + drops null', () => {
    expect(evaluate(call('concat', str('road_'), num(5)), {})).toBe('road_5')
    expect(evaluate(call('concat', str('a'), field('missing'), str('b')), {})).toBe('ab')
  })

  it('downcase / upcase', () => {
    expect(evaluate(call('downcase', str('HeLLo')), {})).toBe('hello')
    expect(evaluate(call('upcase', str('HeLLo')), {})).toBe('HELLO')
  })

  it('typeof', () => {
    expect(evaluate(call('typeof', str('x')), {})).toBe('string')
    expect(evaluate(call('typeof', num(1)), {})).toBe('number')
    expect(evaluate(call('typeof', bool(true)), {})).toBe('boolean')
    expect(evaluate(call('typeof', field('missing')), {})).toBe('null')
  })

  it('slice — string', () => {
    expect(evaluate(call('slice', str('hello'), num(1), num(3)), {})).toBe('el')
    expect(evaluate(call('slice', str('hello'), num(2)), {})).toBe('llo')
  })

  it('get with string-literal key', () => {
    expect(evaluate(call('get', str('name:ko')), { 'name:ko': '서울' })).toBe('서울')
    expect(evaluate(call('get', str('absent')), {})).toBe(null)
  })

  it('get with dynamic key', () => {
    expect(evaluate(call('get', field('keyName')), { keyName: 'x', x: 42 })).toBe(42)
  })

  it('step — legacy 4-arg (non-numeric below/above)', () => {
    // step(val, threshold, below, above)
    expect(evaluate(call('step', num(5), num(12), str('small'), str('large')), {})).toBe('small')
    expect(evaluate(call('step', num(20), num(12), str('small'), str('large')), {})).toBe('large')
  })

  it('step — Mapbox N-stop (numeric stops)', () => {
    // step(input, def, stop1, val1, stop2, val2)
    const e = call('step', num(7), str('def'), num(5), str('a'), num(10), str('b'))
    expect(evaluate(e, {})).toBe('a') // 7 ≥ 5, < 10
    const e2 = call('step', num(11), str('def'), num(5), str('a'), num(10), str('b'))
    expect(evaluate(e2, {})).toBe('b')
    const e3 = call('step', num(3), str('def'), num(5), str('a'), num(10), str('b'))
    expect(evaluate(e3, {})).toBe('def') // below first stop
  })

  it('interpolate — linear between stops', () => {
    // interpolate(input, x1, y1, x2, y2): at input=5 between (0,0)-(10,100) → 50
    expect(evaluate(call('interpolate', num(5), num(0), num(0), num(10), num(100)), {})).toBe(50)
    // clamp below first stop
    expect(evaluate(call('interpolate', num(-5), num(0), num(0), num(10), num(100)), {})).toBe(0)
    // clamp above last stop
    expect(evaluate(call('interpolate', num(15), num(0), num(0), num(10), num(100)), {})).toBe(100)
  })

  it('interpolate — exact stop hit returns stop value', () => {
    expect(evaluate(call('interpolate', num(10), num(0), num(0), num(10), num(100)), {})).toBe(100)
    expect(evaluate(call('interpolate', num(0), num(0), num(0), num(10), num(100)), {})).toBe(0)
  })

  it('interpolate — non-numeric y picks the CLOSER stop', () => {
    // Non-numeric y: returns whichever stop is nearer. Tie (input
    // exactly midway) breaks to the upper stop b.y (the `<` is
    // strict). input=3 closer to a.x=0 → 'a'; input=8 closer to
    // b.x=10 → 'b'; input=5 (tie) → 'b'.
    expect(evaluate(call('interpolate', num(3), num(0), str('a'), num(10), str('b')), {})).toBe('a')
    expect(evaluate(call('interpolate', num(8), num(0), str('a'), num(10), str('b')), {})).toBe('b')
    expect(evaluate(call('interpolate', num(5), num(0), str('a'), num(10), str('b')), {})).toBe('b')
  })

  it('length — string + array', () => {
    expect(evaluate(call('length', str('hello')), {})).toBe(5)
    expect(evaluate(call('length', arr(num(1), num(2), num(3))), {})).toBe(3)
  })
})

describe('iter-310 evaluator AST kinds', () => {
  it('ConditionalExpr — both branches', () => {
    expect(evaluate(cond(bool(true), num(1), num(2)), {})).toBe(1)
    expect(evaluate(cond(bool(false), num(1), num(2)), {})).toBe(2)
  })

  it('ConditionalExpr — truthiness of condition', () => {
    expect(evaluate(cond(num(0), str('t'), str('f')), {})).toBe('f') // 0 falsy
    expect(evaluate(cond(num(1), str('t'), str('f')), {})).toBe('t')
    expect(evaluate(cond(str(''), str('t'), str('f')), {})).toBe('f') // '' falsy
  })

  it('ArrayLiteral — element evaluation', () => {
    const r = evaluate(arr(num(1), call('scale', num(2), num(3)), str('x')), {})
    expect(r).toEqual([1, 6, 'x'])
  })

  it('ArrayAccess — valid index', () => {
    const access: AST.Expr = {
      kind: 'ArrayAccess',
      array: arr(num(10), num(20), num(30)),
      index: num(1),
    } as AST.Expr
    expect(evaluate(access, {})).toBe(20)
  })

  it('UnaryExpr — negate + not', () => {
    const neg: AST.Expr = { kind: 'UnaryExpr', op: '-', operand: num(5) } as AST.Expr
    expect(evaluate(neg, {})).toBe(-5)
    const not: AST.Expr = { kind: 'UnaryExpr', op: '!', operand: bool(false) } as AST.Expr
    expect(evaluate(not, {})).toBe(true)
  })

  it('PipeExpr — value piped through transforms', () => {
    // 5 |> scale(2) |> round   ==   round(scale(5, 2)) = 10
    const pipe: AST.Expr = {
      kind: 'PipeExpr',
      input: num(5),
      transforms: [
        { callee: { kind: 'Identifier', name: 'scale' }, args: [num(2)] },
        { callee: { kind: 'Identifier', name: 'round' }, args: [] },
      ],
    } as AST.Expr
    expect(evaluate(pipe, {})).toBe(10)
  })

  it('Identifier — zoom reserved key', () => {
    expect(evaluate(id('zoom'), { [CAMERA_ZOOM_KEY]: 14 })).toBe(14)
    expect(evaluate(id('zoom'), {})).toBe(null)
  })

  it('match() — arm match + default', () => {
    const matchExpr: AST.Expr = {
      kind: 'FnCall',
      callee: { kind: 'Identifier', name: 'match' },
      args: [field('class')],
      matchBlock: {
        arms: [
          { pattern: 'road', value: str('R') },
          { pattern: 'water', value: str('W') },
          { pattern: '_', value: str('?') },
        ],
      },
    } as AST.Expr
    expect(evaluate(matchExpr, { class: 'road' })).toBe('R')
    expect(evaluate(matchExpr, { class: 'water' })).toBe('W')
    expect(evaluate(matchExpr, { class: 'park' })).toBe('?') // default
    expect(evaluate(matchExpr, {})).toBe('?') // missing → default
  })
})
