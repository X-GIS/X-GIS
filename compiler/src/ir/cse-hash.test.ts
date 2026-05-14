// ═══════════════════════════════════════════════════════════════════
// cse-hash.ts — canonical AST string tests
// ═══════════════════════════════════════════════════════════════════
//
// Asserts the canonical string contract:
//   1. Identical expressions canonicalise to the same string.
//   2. Different expressions canonicalise to different strings.
//   3. Position-sensitive constructs (match arm order, fn arg order,
//      array element order, pipe transform order) preserve order.
//   4. Edge cases (embedded quotes, unit suffixes, null FieldAccess
//      objects, nested matchBlocks on FnCalls) don't collide.

import { describe, expect, it } from 'vitest'
import { canonicalExpr, exprEqual } from './cse-hash'
import type {
  Expr, BinaryExpr, ColorLiteral, FieldAccess, FnCall, Identifier,
  MatchBlock, NumberLiteral, StringLiteral,
} from '../parser/ast'

const num = (value: number, unit: string | null = null): NumberLiteral => ({
  kind: 'NumberLiteral', value, unit,
})
const str = (value: string): StringLiteral => ({ kind: 'StringLiteral', value })
const color = (value: string): ColorLiteral => ({ kind: 'ColorLiteral', value })
const ident = (name: string): Identifier => ({ kind: 'Identifier', name })
const field = (f: string, obj: Expr | null = null): FieldAccess => ({
  kind: 'FieldAccess', field: f, object: obj,
})
const fn = (callee: Expr, args: Expr[], matchBlock?: MatchBlock): FnCall => ({
  kind: 'FnCall', callee, args, matchBlock,
})
const bin = (op: string, l: Expr, r: Expr): BinaryExpr => ({
  kind: 'BinaryExpr', op, left: l, right: r,
})
const matchBlock = (arms: Array<{ pattern: string; value: Expr }>): MatchBlock => ({
  kind: 'MatchBlock', arms,
})

describe('canonicalExpr — basic kinds', () => {
  it('NumberLiteral with no unit', () => {
    expect(canonicalExpr(num(42))).toBe('N(42)')
  })

  it('NumberLiteral with unit', () => {
    expect(canonicalExpr(num(2, 'px'))).toBe('N(2:px)')
  })

  it('two distinct number values hash apart', () => {
    expect(canonicalExpr(num(1))).not.toBe(canonicalExpr(num(1.0001)))
  })

  it('StringLiteral with embedded quotes is escaped', () => {
    expect(canonicalExpr(str('a"b'))).toBe('S("a\\"b")')
  })

  it('ColorLiteral round-trip', () => {
    expect(canonicalExpr(color('#ff0000'))).toBe('C(#ff0000)')
  })

  it('BoolLiteral true / false hash apart', () => {
    expect(canonicalExpr({ kind: 'BoolLiteral', value: true })).toBe('B(1)')
    expect(canonicalExpr({ kind: 'BoolLiteral', value: false })).toBe('B(0)')
  })

  it('Identifier carries the name', () => {
    expect(canonicalExpr(ident('zoom'))).toBe('I(zoom)')
  })

  it('FieldAccess with null object', () => {
    expect(canonicalExpr(field('class'))).toBe('F(class;~)')
  })

  it('FieldAccess with nested object', () => {
    expect(canonicalExpr(field('a', field('b')))).toBe('F(a;F(b;~))')
  })
})

describe('canonicalExpr — function / binary / unary / pipe / conditional', () => {
  it('FnCall with two args + no matchBlock', () => {
    expect(canonicalExpr(fn(ident('clamp'), [num(0), num(10)])))
      .toBe('Fn(I(clamp);[N(0),N(10)];~)')
  })

  it('FnCall with matchBlock', () => {
    const mb = matchBlock([
      { pattern: 'school',   value: color('#f0e8f8') },
      { pattern: 'hospital', value: color('#f5deb3') },
      { pattern: '_',        value: color('#cccccc') },
    ])
    const out = canonicalExpr(fn(ident('match'), [field('class')], mb))
    expect(out).toContain('Fn(I(match);[F(class;~)];M(')
    expect(out).toContain('school->C(#f0e8f8)')
    expect(out).toContain('hospital->C(#f5deb3)')
    expect(out).toContain('_->C(#cccccc)')
  })

  it('BinaryExpr same operands different op', () => {
    const ab = bin('+', ident('a'), ident('b'))
    const ab2 = bin('-', ident('a'), ident('b'))
    expect(canonicalExpr(ab)).not.toBe(canonicalExpr(ab2))
  })

  it('BinaryExpr is operand-position-sensitive (a + b ≠ b + a)', () => {
    const ab = bin('+', ident('a'), ident('b'))
    const ba = bin('+', ident('b'), ident('a'))
    expect(canonicalExpr(ab)).not.toBe(canonicalExpr(ba))
  })

  it('UnaryExpr', () => {
    expect(canonicalExpr({ kind: 'UnaryExpr', op: '-', operand: ident('a') }))
      .toBe('Un(-;I(a))')
  })

  it('ConditionalExpr', () => {
    expect(canonicalExpr({
      kind: 'ConditionalExpr',
      condition: bin('>', ident('zoom'), num(10)),
      thenExpr: color('#ff0000'),
      elseExpr: color('#0000ff'),
    })).toBe('Cond(Bin(>;I(zoom);N(10));C(#ff0000);C(#0000ff))')
  })
})

describe('canonicalExpr — arrays + match + pipe', () => {
  it('ArrayLiteral preserves element order', () => {
    expect(canonicalExpr({ kind: 'ArrayLiteral', elements: [num(1), num(2)] }))
      .toBe('Arr([N(1),N(2)])')
    expect(canonicalExpr({ kind: 'ArrayLiteral', elements: [num(2), num(1)] }))
      .not.toBe(canonicalExpr({ kind: 'ArrayLiteral', elements: [num(1), num(2)] }))
  })

  it('ArrayAccess', () => {
    expect(canonicalExpr({
      kind: 'ArrayAccess',
      array: ident('xs'),
      index: num(0),
    })).toBe('Idx(I(xs);N(0))')
  })

  it('MatchBlock arms are position-sensitive (first-match semantics)', () => {
    const ab = matchBlock([
      { pattern: 'a', value: num(1) },
      { pattern: 'b', value: num(2) },
    ])
    const ba = matchBlock([
      { pattern: 'b', value: num(2) },
      { pattern: 'a', value: num(1) },
    ])
    expect(canonicalExpr(ab)).not.toBe(canonicalExpr(ba))
  })

  it('PipeExpr captures the transform order', () => {
    expect(canonicalExpr({
      kind: 'PipeExpr',
      input: ident('a'),
      transforms: [fn(ident('round'), []), fn(ident('clamp'), [num(0), num(1)])],
    })).toBe('Pipe(I(a);[Fn(I(round);[];~),Fn(I(clamp);[N(0),N(1)];~)])')
  })
})

describe('exprEqual', () => {
  it('returns true for structurally identical expressions', () => {
    const a = bin('+', field('lat'), num(1))
    const b = bin('+', field('lat'), num(1))
    expect(exprEqual(a, b)).toBe(true)
  })

  it('returns false when nested field name differs', () => {
    const a = bin('+', field('lat'), num(1))
    const b = bin('+', field('lon'), num(1))
    expect(exprEqual(a, b)).toBe(false)
  })

  it('returns false when one side has a matchBlock and the other does not', () => {
    const a = fn(ident('match'), [field('class')])
    const b = fn(ident('match'), [field('class')], matchBlock([
      { pattern: 'x', value: num(1) },
    ]))
    expect(exprEqual(a, b)).toBe(false)
  })

  it('treats a number with no unit as different from one with a unit', () => {
    expect(exprEqual(num(10), num(10, 'px'))).toBe(false)
  })

  it('two compound landuse match() blocks differing in one arm hash apart', () => {
    // Regression scenario: shader-gen's matchArmsKey (commit ba348aa)
    // disambiguates two compound layers with the same field but
    // different arm-to-colour mappings. canonicalExpr generalises
    // that disambiguation.
    const a = fn(ident('match'), [field('class')], matchBlock([
      { pattern: 'school',   value: color('#f0e8f8') },
      { pattern: 'hospital', value: color('#f5deb3') },
    ]))
    const b = fn(ident('match'), [field('class')], matchBlock([
      { pattern: 'school',   value: color('#f0e8f8') },
      { pattern: 'hospital', value: color('#ffffff') },  // ← differs
    ]))
    expect(exprEqual(a, b)).toBe(false)
  })

  it('shared subtree across fill + stroke matches (CSE motivating case)', () => {
    // `get(.class)` referenced in both fill match() and stroke
    // match() — CSE pass will dedup to one compute-pass eval.
    const fillKey = canonicalExpr(field('class'))
    const strokeKey = canonicalExpr(field('class'))
    expect(fillKey).toBe(strokeKey)
  })
})
