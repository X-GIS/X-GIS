// Pin Mapbox `["==", x, null]` / `["!=", x, null]` filter support.
// Pre-fix exprToXgis bailed on `null` literal — collapsed to
// "not converted" and the whole comparison dropped silently. Now
// emits the xgis `null` identifier which evaluates via the props
// fast-miss (`props['null'] ?? null` → null, then strict equality
// matches a missing-field null).

import { describe, it, expect } from 'vitest'
import { exprToXgis, filterToXgis } from '../convert/expressions'
import { evaluate } from '../eval/evaluator'

describe('null comparison in filters', () => {
  it('["==", ["get", "field"], null] lowers to .field == null', () => {
    const w: string[] = []
    expect(filterToXgis(['==', ['get', 'field'], null], w))
      .toBe('.field == null')
  })

  it('["!=", ["get", "field"], null] lowers to .field != null', () => {
    const w: string[] = []
    expect(filterToXgis(['!=', ['get', 'field'], null], w))
      .toBe('.field != null')
  })

  it('null comparison round-trips through the evaluator', () => {
    // .field == null with a missing field → true.
    const ast = {
      kind: 'BinaryExpr' as const,
      op: '==',
      left: { kind: 'FieldAccess' as const, object: null, field: 'field' },
      right: { kind: 'Identifier' as const, name: 'null' },
    }
    expect(evaluate(ast as never, {})).toBe(true)
    expect(evaluate(ast as never, { field: 'value' })).toBe(false)
  })

  it('bare exprToXgis(null) returns the null identifier string', () => {
    const w: string[] = []
    expect(exprToXgis(null, w)).toBe('null')
  })

  it('undefined still returns null (not converted) for short-circuit callers', () => {
    const w: string[] = []
    expect(exprToXgis(undefined, w)).toBeNull()
  })
})
