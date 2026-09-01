// ═══ Mapbox `["array", …]` is an ASSERTION, not a pass-through (#2166 B3) ═══
//
// `arrayHandler` used to return the inner value and drop the assertion. The
// spec-coverage note justified that with "X-GIS arrays carry no per-element
// type tag" — a GPU-lane fact about a CPU-lane op: `array` produces an array,
// and ir/classify.ts sends every ArrayLiteral / ArrayAccess to
// 'per-feature-cpu', so the op never reaches a shader and `callBuiltin` sees
// real JS values (`Array.isArray` and `typeof` are already used there).
//
// The note's consolation — "in paint/filter use a non-array would null-cascade
// anyway" — was ALSO false. Measured on the pre-fix base, only the `["at", …]`
// consumer nulled; the rest silently produced a plausible WRONG value:
//     ["length", ["array", ["get","pts"]]]        pts="abcde"  →  5
//     ["slice",  ["array", ["get","pts"]], 0, 2]  pts="abcde"  →  "ab"
//     ["array","number",2,["get","off"]]          off="abcde"  →  "abcde"
//
// The assertion now lowers to the `assert_array` CPU builtin, which returns
// the array when it satisfies the (element-type, length) constraint and null
// when it does not. Null — not a raised error — is X-GIS's fail-soft
// convention, the same one `to_rgba` documents; see the residual noted on the
// `array` spec-coverage row.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'
import { evaluate } from '../eval/evaluator'
import { Lexer } from '../lexer/lexer'
import { Parser, parseExpressionString } from '../parser/parser'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { lower } from '../ir/lower'
import { UNKNOWN_FUNCTION } from '../diagnostics/diagnostic'
import { withPragma } from './_pragma'

function convert(mapbox: unknown): { src: string | null; warnings: string[] } {
  const warnings: string[] = []
  return { src: exprToXgis(mapbox as never, warnings), warnings }
}

/** Drive the whole production path: Mapbox JSON → converter → xgis source →
 *  parser → evaluator. Nothing here reaches into the handler or the builtin
 *  directly, so a lowering that stops emitting the assertion fails too. */
function convertAndRun(mapbox: unknown, props: Record<string, unknown> = {}): unknown {
  const { src, warnings } = convert(mapbox)
  expect(warnings).toEqual([])
  expect(src).not.toBeNull()
  return evaluate(parseExpressionString(src as string) as never, props)
}

describe('["array", …] lowers to the assert_array builtin', () => {
  it('["array", value] → arrayness-only assertion', () => {
    expect(convert(['array', ['get', 'pts']]).src).toBe('assert_array(.pts)')
  })

  it('["array", type, value] → element-type assertion', () => {
    expect(convert(['array', 'number', ['get', 'pts']]).src).toBe('assert_array(.pts, "number")')
  })

  it('["array", type, N, value] → element-type + length assertion', () => {
    expect(convert(['array', 'number', 2, ['get', 'pts']]).src).toBe(
      'assert_array(.pts, "number", 2)',
    )
  })

  it('a literal inner array is asserted too (no convert-time pass-through)', () => {
    expect(convert(['array', 'number', 2, ['literal', [1, 2]]]).src).toBe(
      'assert_array([1, 2], "number", 2)',
    )
  })
})

describe('the assertion HOLDS at runtime', () => {
  it('a conforming array passes through unchanged', () => {
    expect(convertAndRun(['array', 'number', 2, ['literal', [1, 2]]])).toEqual([1, 2])
    expect(convertAndRun(['array', ['get', 'pts']], { pts: [4, 2] })).toEqual([4, 2])
  })

  it('FAIL-BEFORE: a NON-array no longer passes through — it fails to null', () => {
    expect(convertAndRun(['array', ['get', 'pts']], { pts: 'abcde' })).toBeNull()
    expect(convertAndRun(['array', ['get', 'pts']], { pts: 7 })).toBeNull()
    expect(convertAndRun(['array', ['get', 'pts']], {})).toBeNull()
    // The typed/length forms carry the same arrayness check.
    expect(convertAndRun(['array', 'number', 2, ['get', 'off']], { off: 'abcde' })).toBeNull()
  })

  it('FAIL-BEFORE: a wrong ELEMENT TYPE fails', () => {
    expect(convertAndRun(['array', 'number', ['literal', ['a', 'b']]])).toBeNull()
    expect(convertAndRun(['array', 'string', ['literal', [1, 2]]])).toBeNull()
    expect(convertAndRun(['array', 'boolean', ['literal', [true, 1]]])).toBeNull()
    // …and the matching element type still passes.
    expect(convertAndRun(['array', 'string', ['literal', ['a', 'b']]])).toEqual(['a', 'b'])
  })

  it('FAIL-BEFORE: a wrong LENGTH fails', () => {
    expect(convertAndRun(['array', 'number', 2, ['literal', [1, 2, 3]]])).toBeNull()
    expect(convertAndRun(['array', 'number', 2, ['literal', [1]]])).toBeNull()
  })

  it('the untyped form constrains arrayness only — mixed elements pass', () => {
    expect(convertAndRun(['array', ['literal', [1, 'a', true]]])).toEqual([1, 'a', true])
  })

  it('an item type outside string/number/boolean degrades to arrayness only', () => {
    // Mapbox rejects such a style at parse time; X-GIS keeps the half of the
    // assertion it can still decide rather than dropping the expression.
    expect(convert(['array', 'vector', ['get', 'pts']]).src).toBe('assert_array(.pts)')
    expect(convertAndRun(['array', 'vector', ['get', 'pts']], { pts: [1, 2] })).toEqual([1, 2])
    expect(convertAndRun(['array', 'vector', ['get', 'pts']], { pts: 'abcde' })).toBeNull()
  })
})

describe('the assertion reaches the consumers that previously read a non-array', () => {
  it('CAUSE: the assertion itself nulls on a string property', () => {
    expect(convertAndRun(['array', ['get', 'pts']], { pts: 'abcde' })).toBeNull()
  })

  it('EFFECT: ["length", ["array", …]] no longer measures a string as an array', () => {
    // Pre-fix this returned 5 — `length` accepts a string (evaluator-helpers
    // `length`), so the dropped assertion let a string be measured.
    expect(convertAndRun(['length', ['array', ['get', 'pts']]], { pts: 'abcde' })).toBe(0)
    expect(convertAndRun(['length', ['array', ['get', 'pts']]], { pts: [1, 2, 3] })).toBe(3)
  })

  it('EFFECT: ["slice", ["array", …]] no longer substrings a string', () => {
    // Pre-fix this returned "ab" — `slice` accepts a string too.
    expect(convertAndRun(['slice', ['array', ['get', 'pts']], 0, 2], { pts: 'abcde' })).toBeNull()
    expect(convertAndRun(['slice', ['array', ['get', 'pts']], 0, 2], { pts: [1, 2, 3] })).toEqual([
      1, 2,
    ])
  })
})

describe('the emitted callee is a registered builtin', () => {
  it('a converted style carrying ["array", …] lowers with no X-GIS0012', () => {
    const xgis = convertMapboxStyle({
      version: 8,
      sources: { p: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'd',
          type: 'circle',
          source: 'p',
          paint: { 'circle-radius': ['length', ['array', 'number', 2, ['get', 'pts']]] },
        },
      ],
    } as never)
    expect(xgis).toContain('assert_array(')
    const program = new Parser(new Lexer(withPragma(xgis)).tokenize()).parse()
    const diags = (lower(program).diagnostics ?? []).filter((d) => d.code === UNKNOWN_FUNCTION)
    expect(diags).toEqual([])
  })
})
