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

  // A MALFORMED option is still undecidable: `"yes"` is a constant of the
  // wrong type, which the Mapbox reference implementation rejects at parse
  // time (`context.parse(options['case-sensitive'], 1, BooleanType)`). Blindly
  // recursing it would emit `collator_cmp(…, "yes", …)` and the evaluator's
  // Boolean() coercion would invent a case-sensitive:true the style never
  // authored. Warn-and-drop is the honest answer.
  //
  // The message must NAME the wrong-typed constant, not just say "malformed":
  // three different failures reach this fallback and the author needs to know
  // which one is theirs (see the un-lowerable-expression case below).
  it('a WRONG-TYPED constant option → fall back to byte-exact + warning naming the slot', () => {
    const { result, warnings } = convert([
      '==',
      ['get', 'a'],
      'x',
      ['collator', { 'case-sensitive': 'yes' }],
    ])
    expect(result).toBe('.a == "x"')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"case-sensitive" must be a boolean')
    expect(warnings[0]).toContain('got "yes"')
    expect(warnings[0]).toContain('falling back to byte-exact compare')
  })

  // Mirrors the reference implementation's own
  // `Collator options argument must be an object.` parse error.
  it('a non-object options argument → fall back to byte-exact + warning', () => {
    const { result, warnings } = convert(['==', ['get', 'a'], 'x', ['collator', 42]])
    expect(result).toBe('.a == "x"')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('options argument must be an object literal')
    expect(warnings[0]).toContain('got 42')
  })

  // An UN-LOWERABLE option expression is a different failure from a malformed
  // options object, and the diagnostic must say so — the pre-review message
  // asserted the options were "malformed" and enumerated type rules, sending
  // the author to fix an options object that is correct. `recurse` has already
  // named the operator it could not convert; this message names the SLOT.
  it('an un-lowerable option expression → names the slot, not "malformed options"', () => {
    const { result, warnings } = convert([
      '==',
      ['get', 'n'],
      'x',
      ['collator', { locale: ['bogus-op', 1] }],
    ])
    expect(result).toBe('.n == "x"')
    // The recursion's own diagnostic names the operator …
    expect(warnings.some((w) => /bogus-op/.test(w))).toBe(true)
    // … and this one names the slot, WITHOUT calling the options malformed.
    const own = warnings.filter((w) => /\["collator", …\]/.test(w))
    expect(own).toHaveLength(1)
    expect(own[0]).toContain('"locale" option expression could not be converted')
    expect(own[0]).not.toContain('malformed')
  })

  it('end-to-end: case-insensitive match evaluates true', () => {
    const { result } = convert(['==', ['get', 'name'], 'cafe', ['collator', CI]])
    expect(evalSrc(result as string, { name: 'CAFE' })).toBe(true)
  })
})

// PER-FEATURE (expression-valued) collator options. `collator_cmp` is a CPU
// builtin and `callBuiltin` dispatches on ALREADY-EVALUATED arguments, so an
// expression in an option slot is decided at eval time — it never needed to be
// a compile-time literal. Each witness asserts BOTH states of the feature
// property, so the emitted slot demonstrably carries information: if the option
// were dropped (the pre-#2166 byte-exact fallback) both states would agree.
describe('collator comparison with per-feature (expression) options', () => {
  it('a per-feature LOCALE lowers into the collator_cmp locale slot', () => {
    const { result, warnings } = convert([
      '==',
      ['get', 'name'],
      'I',
      ['collator', { locale: ['get', 'lang'] }],
    ])
    expect(warnings).toEqual([])
    expect(result).toBe('collator_cmp("==", .name, "I", .lang, false, false)')
    // Turkish dotless i: `ı` is the lowercase of `I` in tr, of nothing in en.
    expect(evalSrc(result as string, { name: 'ı', lang: 'tr' })).toBe(true)
    expect(evalSrc(result as string, { name: 'ı', lang: 'en' })).toBe(false)
  })

  it('a per-feature case-sensitive lowers into the cs slot', () => {
    const { result, warnings } = convert([
      '==',
      ['get', 'name'],
      'cafe',
      ['collator', { 'case-sensitive': ['get', 'cs'] }],
    ])
    expect(warnings).toEqual([])
    expect(result).toBe('collator_cmp("==", .name, "cafe", "", .cs, false)')
    expect(evalSrc(result as string, { name: 'CAFE', cs: false })).toBe(true)
    expect(evalSrc(result as string, { name: 'CAFE', cs: true })).toBe(false)
  })

  it('a per-feature diacritic-sensitive lowers into the ds slot', () => {
    const { result, warnings } = convert([
      '==',
      ['get', 'name'],
      'cafe',
      ['collator', { 'diacritic-sensitive': ['get', 'ds'] }],
    ])
    expect(warnings).toEqual([])
    expect(result).toBe('collator_cmp("==", .name, "cafe", "", false, .ds)')
    expect(evalSrc(result as string, { name: 'café', ds: false })).toBe(true)
    expect(evalSrc(result as string, { name: 'café', ds: true })).toBe(false)
  })

  it('constant and expression options mix in one collator', () => {
    const { result, warnings } = convert([
      '==',
      ['get', 'name'],
      'cafe',
      ['collator', { 'case-sensitive': false, 'diacritic-sensitive': ['get', 'ds'], locale: 'en' }],
    ])
    expect(warnings).toEqual([])
    expect(result).toBe('collator_cmp("==", .name, "cafe", "en", false, .ds)')
    expect(evalSrc(result as string, { name: 'CAFÉ', ds: false })).toBe(true)
    expect(evalSrc(result as string, { name: 'CAFÉ', ds: true })).toBe(false)
  })

  it('a `["literal", …]`-wrapped option stays a CONSTANT, not an expression', () => {
    const { result, warnings } = convert([
      '==',
      ['get', 'a'],
      'b',
      ['collator', { 'case-sensitive': ['literal', true], locale: ['get', 'lang'] }],
    ])
    expect(warnings).toEqual([])
    expect(result).toBe('collator_cmp("==", .a, "b", .lang, true, false)')
  })

  // WITNESS for the divergence the `collator` coverage row now records, so the
  // row is a property of the code rather than a sentence. The constant guard
  // has a TYPE check; the expression path cannot (the type is not known until
  // eval), and X-GIS has no evaluation-error channel — so `collator_cmp`
  // COERCES where the pinned reference implementation type-asserts.
  //
  // Measured against @maplibre/maplibre-gl-style-spec 24.8.5 on the same
  // inputs: a wrong-TYPED option expression is a parse error there
  // ("Expected boolean but found array instead."), and a well-typed expression
  // whose runtime value is the wrong type raises at eval ("Expected value to be
  // of type boolean, but found string instead.") so the property falls back to
  // its default. Neither happens here — and the difference is VISIBLE, not
  // academic: `cs: "false"` selects a case-SENSITIVE compare.
  it('an option EXPRESSION is not type-checked at convert time — coercion pinned', () => {
    // (a) wrong-TYPED expression: accepted silently, unlike the constant form.
    const wrongType = convert([
      '==',
      ['get', 'n'],
      'x',
      ['collator', { 'case-sensitive': ['array', ['get', 'k']] }],
    ])
    expect(wrongType.warnings).toEqual([])
    expect(wrongType.result).toBe('collator_cmp("==", .n, "x", "", assert_array(.k), false)')

    // (b) the coercion that follows, on the ordinary `["get"]` spelling.
    const { result, warnings } = convert([
      '==',
      ['get', 'name'],
      'cafe',
      ['collator', { 'case-sensitive': ['get', 'cs'] }],
    ])
    expect(warnings).toEqual([])
    // A tile that stringifies its booleans flips the answer: Boolean("false")
    // is TRUE, so the compare is case-sensitive and "CAFE" != "cafe".
    expect(evalSrc(result as string, { name: 'CAFE', cs: 'false' })).toBe(false)
    // …while the empty string is falsy, so the SAME property spelling with a
    // different stringification is case-insensitive. Both arms assert, so the
    // witness distinguishes coercion from a type assertion: a type assertion
    // would make these two agree (both falling back to the default).
    expect(evalSrc(result as string, { name: 'CAFE', cs: '' })).toBe(true)
    // An ABSENT property coerces to false — case-insensitive — where the
    // reference raises and the property falls back to its default.
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

  // resolved-locale reads ONLY the collator's locale. A non-constant SIBLING
  // option (case-sensitive here) is irrelevant to the returned tag, so it must
  // not drop the whole expression — the comparison path's all-or-nothing
  // extractor is not this handler's contract.
  it('constant locale survives a non-constant SIBLING option', () => {
    const { result, warnings } = convert([
      'resolved-locale',
      ['collator', { locale: 'de', 'case-sensitive': ['get', 'cs'] }],
    ])
    expect(warnings).toEqual([])
    expect(result).toBe('resolved_locale("de")')
  })

  it('a collator with no options → default locale', () => {
    const { result, warnings } = convert(['resolved-locale', ['collator']])
    expect(warnings).toEqual([])
    expect(result).toBe('resolved_locale("")')
  })

  // Negative control: the change is "read only the option I need", not "stop
  // validating". A non-constant LOCALE is still undecidable at compile time.
  it('non-constant locale still warns + drops', () => {
    const { result, warnings } = convert([
      'resolved-locale',
      ['collator', { locale: ['get', 'loc'] }],
    ])
    expect(result).toBeNull()
    expect(warnings.some((w) => /resolved-locale/.test(w))).toBe(true)
  })

  it('a non-collator argument still warns + drops', () => {
    const { result, warnings } = convert(['resolved-locale', ['get', 'lang']])
    expect(result).toBeNull()
    expect(warnings.some((w) => /resolved-locale/.test(w))).toBe(true)
  })
})
