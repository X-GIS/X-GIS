// Converter + evaluator: Mapbox `collator` (comparison 4th arg) and
// `resolved-locale`. The collator lowers to the `collator_cmp` CPU builtin;
// resolved-locale to `resolved_locale`. Pairs with eval/collator.test.ts.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'
import { evaluate } from '../eval/evaluator'
import { parseExpressionString } from '../parser/parser'

function convert(mapbox: unknown): { result: string | null; warnings: string[] } {
  const warnings: string[] = []
  return { result: exprToXgis(mapbox as never, warnings), warnings }
}

function evalSrc(src: string, props: Record<string, unknown> = {}): unknown {
  return evaluate(parseExpressionString(src) as never, props)
}

const CI = { 'case-sensitive': false, 'diacritic-sensitive': false, locale: 'en' }

describe('collator comparison converter', () => {
  it('["==", a, b, collator] → collator_cmp(...) with baked opts', () => {
    const { result, warnings } = convert(['==', ['get', 'name'], 'Café', ['collator', CI]])
    expect(warnings).toEqual([])
    expect(result).toBe('collator_cmp("==", .name, "Café", "en", false, false)')
  })

  it('case + diacritic flags are threaded through', () => {
    const { result } = convert([
      '<',
      ['get', 'a'],
      ['get', 'b'],
      ['collator', { 'case-sensitive': true, 'diacritic-sensitive': true }],
    ])
    expect(result).toBe('collator_cmp("<", .a, .b, "", true, true)')
  })

  it('non-constant collator option → fall back to byte-exact + warning', () => {
    const { result, warnings } = convert([
      '==',
      ['get', 'a'],
      'x',
      ['collator', { 'case-sensitive': ['get', 'flag'] }],
    ])
    expect(result).toBe('.a == "x"')
    expect(warnings.some((w) => /non-constant options/.test(w))).toBe(true)
  })

  it('end-to-end: case-insensitive match evaluates true', () => {
    const { result } = convert(['==', ['get', 'name'], 'cafe', ['collator', CI]])
    expect(evalSrc(result as string, { name: 'CAFE' })).toBe(true)
  })
})

describe('resolved-locale converter', () => {
  it('["resolved-locale", collator] → resolved_locale("<locale>")', () => {
    const { result, warnings } = convert(['resolved-locale', ['collator', { locale: 'tr' }]])
    expect(warnings).toEqual([])
    expect(result).toBe('resolved_locale("tr")')
    expect(String(evalSrc(result as string))).toMatch(/^tr/i)
  })

  it('malformed arity → drops with a warning', () => {
    const { result, warnings } = convert(['resolved-locale'])
    expect(result).toBeNull()
    expect(warnings.some((w) => /resolved-locale/.test(w))).toBe(true)
  })
})
