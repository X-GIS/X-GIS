// Pin `["literal", [...]]` → xgis array-literal conversion. Mapbox
// styles use the wrapper to hold constant arrays (dash arrays, RGB
// triplets, lookup tables for `at` / `match` value arms). Pre-fix
// exprToXgis recursed on the inner array, found no operator string,
// and emitted the generic "Expression not converted" warning —
// callers fell back to null. Now lowered to the xgis ArrayLiteral
// shape `[a, b, c]` so the runtime evaluator sees a real array.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'

describe('exprToXgis — literal array unwrapping', () => {
  it('["literal", [1, 2, 3]] lowers to bare array literal', () => {
    const w: string[] = []
    expect(exprToXgis(['literal', [1, 2, 3]], w)).toBe('[1, 2, 3]')
    expect(w).toEqual([])
  })

  it('["literal", ["a", "b"]] lowers to string-array literal', () => {
    const w: string[] = []
    // String elements get JSON.stringify-quoted by the scalar emitter.
    expect(exprToXgis(['literal', ['a', 'b']], w)).toBe('["a", "b"]')
    expect(w).toEqual([])
  })

  it('["at", 0, ["literal", [10, 20, 30]]] lowers to array indexing', () => {
    // Spec round-trip: Mapbox's typical "fetch the Nth element from a
    // constant lookup" pattern. Pre-fix the literal-array fell to
    // "Expression not converted" and the whole `at` returned null;
    // any layer using it lost its property.
    const w: string[] = []
    const out = exprToXgis(['at', 0, ['literal', [10, 20, 30]]], w)
    expect(out).toBe('[10, 20, 30][0]')
    expect(w).toEqual([])
  })

  it('["literal", [4, 2]] (dash array shape) lowers cleanly', () => {
    // Non-paint context — exercised via the generic expression
    // converter. Paint contexts (line-dasharray) have their own
    // unwrap in addStrokeDash, but anything that routes through
    // exprToXgis directly (a match arm carrying a dash array, etc.)
    // needs THIS path to fire.
    const w: string[] = []
    expect(exprToXgis(['literal', [4, 2]], w)).toBe('[4, 2]')
    expect(w).toEqual([])
  })

  it('scalar literal still passes through unchanged', () => {
    // The fix shouldn't break the bare-scalar pre-existing behaviour.
    const w: string[] = []
    expect(exprToXgis(['literal', 42], w)).toBe('42')
    expect(exprToXgis(['literal', 'hello'], w)).toBe('"hello"')
    expect(exprToXgis(['literal', true], w)).toBe('true')
    expect(w).toEqual([])
  })

  it('nested non-literal arrays inside literal stay rejected', () => {
    // Mapbox spec says the whole subtree under `["literal", ...]` is
    // data, so inner arrays would also need their own data wrapper
    // (or be expressed directly under one outer literal). A bare
    // `[1, 2]` element inside has no `["literal"]` operator and is
    // ambiguous — could be an expression. Reject explicitly so the
    // caller sees a real failure rather than a half-converted form.
    const w: string[] = []
    expect(exprToXgis(['literal', [[1, 2], [3, 4]]], w)).toBeNull()
  })
})
