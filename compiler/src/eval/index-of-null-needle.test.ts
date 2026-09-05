// #2385 — a `null` needle in `index_of` / `index-of` was coerced via
// `String(needle ?? '')`, mapping null → '' — and '' is found at index 0
// in every string, so `index_of(null, haystack) >= 0` was always true.
//
// MapLibre calls `haystack.indexOf(needle)` directly (no `?? ''`), so JS
// coerces with `String(null)` → "null": a null needle means "does the
// literal substring 'null' occur in the haystack".
//
// The LIVE caller is the explicit `["index-of", needle, haystack]`
// expression: expr-string.ts's `indexOfHandler` lowers it with no
// needle-type guard, so a nullable property reaches this arm through the
// ordinary converter. Executed, on this tree:
//   convertMapboxStyle(filter: ['>=', ['index-of', ['get','code'],
//     ['get','name']], 0])  →  `filter: index_of(.code, .name) >= 0`,
//   zero warnings; a feature with `code: null` then feeds a null needle.
//
// `["in", needle, haystack]` does NOT reach here today — expr-lookup.ts's
// `inHandler` lowers only a `["literal", [...]]` haystack (to an
// equality-OR chain) or the legacy string-field form, and warns-and-drops
// everything else (expr-lookup.ts:588). #2326 owns that gap; when it lands
// this same arm becomes the authority for both callers, which is why the
// `["in"]` semantics are pinned below against the MapLibre oracle now.
//
// Oracle values (@maplibre/maplibre-gl-style-spec@24.8.5):
//   featureFilter(['in', null, ['get', 'name']])
//     .filter({zoom: 0}, {type: 1, properties: {name: 'somefoo'}}) // false
//   featureFilter(['in', null, ['get', 'name']])
//     .filter({zoom: 0}, {type: 1, properties: {name: 'xnullx'}}) // true

import { describe, it, expect } from 'vitest'
import { evaluate } from './evaluator'
import type * as AST from '../parser/ast'

// `null` lowers as `Identifier(name: 'null')` (see
// null-comparison-coverage.test.ts) — `props['null']` is never set, so
// it evaluates to `null`.
const nullNeedle: AST.Expr = { kind: 'Identifier', name: 'null' }
// `["get", "name"]` lowers as an object-less `FieldAccess` — `.name`.
const nameField: AST.Expr = { kind: 'FieldAccess', object: null, field: 'name' }

function indexOfCall(needle: AST.Expr, haystack: AST.Expr): AST.Expr {
  return {
    kind: 'FnCall',
    callee: { kind: 'Identifier', name: 'index_of' },
    args: [needle, haystack],
  }
}

// `["in", needle, haystack]` REFERENCE semantics: `index_of(needle,
// haystack) >= 0`. Built by hand here — see the header: the converter does
// not emit this shape yet (#2326). Pinning it now means #2326's lowering
// inherits a checked null-needle contract instead of re-deriving one.
function inCall(needle: AST.Expr, haystack: AST.Expr): AST.Expr {
  return {
    kind: 'BinaryExpr',
    op: '>=',
    left: indexOfCall(needle, haystack),
    right: { kind: 'NumberLiteral', value: 0, unit: null },
  }
}

describe('index_of — null needle (#2385)', () => {
  it('["in", null, ["get","name"]] is false when the haystack has no "null" substring', () => {
    expect(evaluate(inCall(nullNeedle, nameField), { name: 'somefoo' })).toBe(false)
  })

  it('["in", null, ["get","name"]] is true when the haystack contains the literal "null" substring', () => {
    expect(evaluate(inCall(nullNeedle, nameField), { name: 'xnullx' })).toBe(true)
  })

  it('["index-of", null, haystack] returns -1 when "null" is not a substring', () => {
    expect(evaluate(indexOfCall(nullNeedle, nameField), { name: 'somefoo' })).toBe(-1)
  })

  it('["index-of", null, haystack] returns the index of the literal "null" substring', () => {
    expect(evaluate(indexOfCall(nullNeedle, nameField), { name: 'xnullx' })).toBe(1)
  })

  it('control: a non-null needle still finds its substring normally', () => {
    const call = indexOfCall(
      { kind: 'StringLiteral', value: 'foo' },
      { kind: 'StringLiteral', value: 'somefoo' },
    )
    expect(evaluate(call, {})).toBe(4)
  })
})
