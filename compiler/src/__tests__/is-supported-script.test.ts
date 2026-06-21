// Mapbox `["is-supported-script", str]` → constant `true`.
//
// X-GIS rasterises glyphs through Canvas2D / the MapLibre PBF atlas
// with a CJK + Latin + Arabic fallback chain and makes no per-script
// capability distinction — every Unicode string is renderable. The
// FAITHFUL lowering of this accessor for X-GIS' actual capability is
// therefore the constant `true`: a recognised op that always reports
// the script as supported. Mirror of the `["pitch"]` / `["properties"]`
// "recognised accessor, never falls to the unsupported catch-all"
// pattern.

import { describe, it, expect } from 'vitest'
import type * as AST from '../parser/ast'
import { exprToXgis, filterToXgis } from '../convert/expressions'
import { evaluate } from '../eval/evaluator'

function convert(mapbox: unknown): { result: string | null; warnings: string[] } {
  const warnings: string[] = []
  const result = exprToXgis(mapbox as never, warnings)
  return { result, warnings }
}

/** Bare boolean-literal AST node — what the emitted `true` source
 *  parses to. Used to assert the end-to-end evaluation result. */
const boolLit = (value: boolean): AST.Expr => ({ kind: 'BoolLiteral', value } as AST.Expr)

describe('Mapbox ["is-supported-script"] expression accessor', () => {
  it('["is-supported-script", str] → constant `true` (no warning, no catch-all)', () => {
    const { result, warnings } = convert(['is-supported-script', 'Hello'])
    expect(result).toBe('true')
    // Must NOT surface the old "accessor not supported" warning…
    expect(warnings.some(w => w.includes('is-supported-script accessor'))).toBe(false)
    // …and must NOT fall through to the generic catch-all.
    expect(warnings.some(w => w.startsWith('Expression not converted'))).toBe(false)
  })

  it('lowers to `true` regardless of the (string / expression) argument', () => {
    // The arg is intentionally NOT evaluated — the result is invariant.
    expect(convert(['is-supported-script', '日本語'] ).result).toBe('true')
    expect(convert(['is-supported-script', ['get', 'name']]).result).toBe('true')
  })

  it('nested inside a `case` picks the supported branch end-to-end', () => {
    // The canonical use: `["case", ["is-supported-script", t], t, fallback]`.
    // X-GIS always takes the supported branch, so the case lowers with
    // `true` as the first condition.
    const { result } = convert([
      'case',
      ['is-supported-script', ['get', 'name']],
      ['get', 'name'],
      ['get', 'name:latin'],
    ])
    expect(result).not.toBeNull()
    expect(result).toContain('true')
  })

  it('works in filter context (boolean predicate) — always matches', () => {
    const warnings: string[] = []
    const result = filterToXgis(['is-supported-script', 'x'], warnings)
    expect(result).toBe('true')
  })

  it('malformed ["is-supported-script"] (no arg) warns but still returns true', () => {
    const { result, warnings } = convert(['is-supported-script'])
    expect(result).toBe('true')
    expect(warnings.some(w => w.includes('Malformed ["is-supported-script"]'))).toBe(true)
  })

  it('emitted `true` evaluates to the boolean true (DEFAULT = supported branch)', () => {
    // The source the converter emits parses to a BoolLiteral; assert it
    // evaluates to true so the downstream `case` takes the supported arm.
    expect(evaluate(boolLit(true), {})).toBe(true)
  })
})
