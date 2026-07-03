// Mapbox spec strict validation gates: match labels, interpolate
// stops, and `in` operator keys MUST be literal scalars per spec.
// Expression-form values in those positions silently produced wrong
// IR pre-fix (`[object Object]` arms, non-monotonic interpolate axes,
// invalid in-list emits) with no diagnostic. Surfacing the constraint
// at convert time stops them turning into runtime mysteries.

import { describe, expect, it } from 'vitest'
import { exprToXgis } from '../convert/expressions'
import { parseExpressionString } from '../parser/parser'
import { evaluate } from '../eval/evaluator'

describe('Mapbox spec-strict expression validation', () => {
  describe('match labels MUST be literal string/number', () => {
    it('warns and drops arm whose label is ["get", …] (expression-form)', () => {
      const warnings: string[] = []
      const result = exprToXgis(
        // Non-literal label `["get", "key"]` in label position.
        ['match', ['get', 'type'], ['get', 'key'], 1, 0],
        warnings,
      )
      // Either bails the whole match (no valid arms) or emits a match
      // with all bad arms dropped. Either way, a warning surfaces.
      expect(warnings.some((w) => w.includes('["match"]') && w.includes('not literal'))).toBe(true)
      // If a result is produced, the bogus label must not appear.
      if (result !== null) {
        expect(result).not.toContain('get')
      }
    })

    it('accepts literal string labels', () => {
      const warnings: string[] = []
      const result = exprToXgis(['match', ['get', 'type'], 'road', 1, 'rail', 2, 0], warnings)
      expect(result).not.toBeNull()
      expect(warnings.some((w) => w.includes('not literal'))).toBe(false)
    })

    it('accepts literal number labels', () => {
      const warnings: string[] = []
      const result = exprToXgis(['match', ['get', 'rank'], 1, 'a', 2, 'b', 'fallback'], warnings)
      expect(result).not.toBeNull()
      expect(warnings.some((w) => w.includes('not literal'))).toBe(false)
      // The converter emits numeric labels as bare numbers; that output
      // is re-parsed in production, so the round-trip must parse + eval.
      const ast = parseExpressionString(result!)
      expect(evaluate(ast, { rank: 2 })).toBe('b')
    })

    it('accepts array of literal labels (Mapbox shorthand)', () => {
      const warnings: string[] = []
      const result = exprToXgis(['match', ['get', 'type'], ['road', 'highway'], 1, 0], warnings)
      expect(result).not.toBeNull()
    })
  })

  describe('interpolate stop x-values MUST be literal finite numbers', () => {
    it('warns and bails when stop x is ["get", …]', () => {
      const warnings: string[] = []
      const result = exprToXgis(
        ['interpolate', ['linear'], ['zoom'], ['get', 'minZ'], 1, 10, 5],
        warnings,
      )
      expect(result).toBeNull()
      expect(warnings.some((w) => w.includes('literal finite number'))).toBe(true)
    })

    it('warns and bails when stop x is NaN literal', () => {
      const warnings: string[] = []
      const result = exprToXgis(['interpolate', ['linear'], ['zoom'], NaN, 1, 10, 5], warnings)
      expect(result).toBeNull()
      expect(warnings.some((w) => w.includes('literal finite number'))).toBe(true)
    })

    it('accepts ["literal", N] wrap on stop x', () => {
      const warnings: string[] = []
      const result = exprToXgis(
        ['interpolate', ['linear'], ['zoom'], ['literal', 5], 1, ['literal', 10], 5],
        warnings,
      )
      expect(result).not.toBeNull()
      expect(warnings.some((w) => w.includes('literal finite number'))).toBe(false)
    })
  })

  describe('`in` operator keys MUST be literal scalars', () => {
    it('warns and drops keys that are expressions (expression form)', () => {
      const warnings: string[] = []
      const result = exprToXgis(
        ['in', ['get', 'type'], ['literal', ['road', ['get', 'key'], 'highway']]],
        warnings,
      )
      expect(warnings.some((w) => w.includes('["in"]') && w.includes('not literal'))).toBe(true)
      // Result still emits equality on the valid keys.
      if (result !== null) {
        expect(result).toContain('"road"')
        expect(result).toContain('"highway"')
      }
    })

    it('warns and drops keys that are expressions (legacy form)', () => {
      const warnings: string[] = []
      // Legacy: ["in", "field", v1, v2, …]. Pass an object as one
      // key to force the "not literal" branch.
      const result = exprToXgis(['in', 'type', 'road', { bad: true }, 'highway'], warnings)
      expect(warnings.some((w) => w.includes('["in"]') && w.includes('not literal'))).toBe(true)
      if (result !== null) {
        expect(result).toContain('"road"')
        expect(result).toContain('"highway"')
      }
    })

    it('accepts literal boolean keys', () => {
      const warnings: string[] = []
      const result = exprToXgis(['in', ['get', 'flag'], ['literal', [true, false]]], warnings)
      expect(result).not.toBeNull()
      expect(warnings.some((w) => w.includes('not literal'))).toBe(false)
    })
  })
})
