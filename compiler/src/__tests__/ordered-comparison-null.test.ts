// Iter 531 — root cause of OFM Bright highway-shield silent drop.
// Pre-fix: `(.ref_length <= 6)` returned true when ref_length was
// missing/null because toNumber(null)=0 → 0<=6=true. Per Mapbox v8
// spec ordered comparisons (< > <= >=) MUST return false when either
// operand is null / undefined. Without that gate, OFM transportation_
// name features lacking ref_length leaked through the filter; the
// icon-image expression `concat("road_", get("ref_length"))` then
// resolved to "road_" (concat skips nulls), atlas miss, no shield.
//
// Discovered via the iter 526 IconStage.getMissingIconNames()
// diagnostic at iter 531 (bright-texas-shields view).

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { evaluate } from '../eval/evaluator'
import { makeEvalProps } from '../eval/reserved-keys'

function evalExpr(src: string, props: Record<string, unknown>): unknown {
  const tokens = new Lexer('let __x = ' + src).tokenize()
  const ast = new Parser(tokens).parse()
  const stmt = ast.body[0]
  if (stmt.kind !== 'LetStatement') throw new Error('expected LetStatement')
  return evaluate(stmt.value as never, makeEvalProps({ props }))
}

describe('ordered comparison with null/undefined operand (iter 531)', () => {
  describe('the OFM highway-shield gate — `.ref_length <= 6`', () => {
    it('missing field → false (filter rejects)', () => {
      expect(evalExpr('.ref_length <= 6', {})).toBe(false)
    })

    it('null field → false', () => {
      expect(evalExpr('.ref_length <= 6', { ref_length: null })).toBe(false)
    })

    it('undefined field → false', () => {
      expect(evalExpr('.ref_length <= 6', { ref_length: undefined })).toBe(false)
    })

    it('numeric 0 → true (0 <= 6, valid spec-compliant comparison)', () => {
      expect(evalExpr('.ref_length <= 6', { ref_length: 0 })).toBe(true)
    })

    it('numeric 2 → true (the typical I-10 case)', () => {
      expect(evalExpr('.ref_length <= 6', { ref_length: 2 })).toBe(true)
    })

    it('numeric 7 → false (out of range)', () => {
      expect(evalExpr('.ref_length <= 6', { ref_length: 7 })).toBe(false)
    })
  })

  describe('all four ordered operators reject null', () => {
    for (const op of ['<', '>', '<=', '>=']) {
      it(`null ${op} 5 → false`, () => {
        expect(evalExpr(`.x ${op} 5`, { x: null })).toBe(false)
      })

      it(`5 ${op} null → false`, () => {
        expect(evalExpr(`5 ${op} .x`, { x: null })).toBe(false)
      })

      it(`missing ${op} 5 → false`, () => {
        expect(evalExpr(`.x ${op} 5`, {})).toBe(false)
      })
    }
  })

  describe('valid comparisons still work (regression gate)', () => {
    it('numeric < numeric', () => {
      expect(evalExpr('.a < 10', { a: 5 })).toBe(true)
      expect(evalExpr('.a < 10', { a: 15 })).toBe(false)
    })

    it('numeric == numeric (not affected by null gate)', () => {
      expect(evalExpr('.a == 5', { a: 5 })).toBe(true)
      expect(evalExpr('.a == 5', { a: null })).toBe(false)
      expect(evalExpr('.a == 5', {})).toBe(false)
    })

    it('string lex compare still works', () => {
      expect(evalExpr('.s < "z"', { s: 'a' })).toBe(true)
      expect(evalExpr('.s < "z"', { s: 'zz' })).toBe(false)
    })

    it('string lex compare rejects null operand', () => {
      expect(evalExpr('.s < "z"', { s: null })).toBe(false)
    })
  })
})
