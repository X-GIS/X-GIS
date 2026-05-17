// Pin Mapbox `["get", <expression>]` dynamic key access. Mapbox spec
// allows the field name to itself be an expression — common idiom
// for locale-aware label rendering:
//   ["get", ["concat", "name:", ["get", "lang"]]]
// resolving to the localized name field at runtime. Pre-fix the
// converter bailed at the `typeof field !== 'string'` gate; the
// containing expression collapsed to null and every locale-aware
// label dropped.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'
import { evaluate } from '../eval/evaluator'

describe('["get", <expression>] dynamic key access', () => {
  it('static string field still lowers to bare access', () => {
    const w: string[] = []
    expect(exprToXgis(['get', 'name'], w)).toBe('.name')
  })

  it('v8 literal-wrapped static key unwraps to bare access', () => {
    const w: string[] = []
    expect(exprToXgis(['get', ['literal', 'name']], w)).toBe('.name')
  })

  it('v8 literal-wrapped colon-key unwraps to get("…")', () => {
    const w: string[] = []
    expect(exprToXgis(['get', ['literal', 'name:en']], w)).toBe('get("name:en")')
  })

  it('["get", ["concat", "name:", ["get", "lang"]]] lowers to get(concat(…))', () => {
    const w: string[] = []
    const out = exprToXgis(['get', ['concat', 'name:', ['get', 'lang']]], w)
    expect(out).toBe('get(concat("name:", .lang))')
  })

  it('dynamic-key get round-trips through the evaluator', () => {
    // Hand-built FnCall AST mirroring the converter's emission shape.
    // The evaluator's get() builtin treats args[0] of type 'string'
    // as a runtime key — picks props[<resolved-key>].
    const ast = {
      kind: 'FnCall' as const,
      callee: { kind: 'Identifier' as const, name: 'get' },
      args: [{
        kind: 'FnCall' as const,
        callee: { kind: 'Identifier' as const, name: 'concat' },
        args: [
          { kind: 'StringLiteral' as const, value: 'name:' },
          { kind: 'FieldAccess' as const, object: null, field: 'lang' },
        ],
      }],
    }
    const props = { lang: 'ko', 'name:ko': '서울', 'name:en': 'Seoul' }
    expect(evaluate(ast as never, props)).toBe('서울')
    expect(evaluate(ast as never, { ...props, lang: 'en' })).toBe('Seoul')
  })
})
