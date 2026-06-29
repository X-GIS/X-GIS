// Tests for the `collator` locale-aware comparison primitives (CPU,
// GPU-free). Mapbox `["==", a, b, ["collator", {…}]]` and friends compare
// strings with case- / diacritic- / locale-sensitivity controlled by the
// collator options; `["resolved-locale", collator]` reports the BCP-47
// tag the collator resolved to. All pure CPU (Intl.Collator).

import { describe, it, expect } from 'vitest'
import { collatorCompare, resolvedLocale } from './collator'

describe('collatorCompare — case sensitivity', () => {
  it('case-insensitive (default): CAFE == cafe → true', () => {
    expect(collatorCompare('==', 'CAFE', 'cafe', '', false, false)).toBe(true)
  })
  it('case-sensitive: CAFE == cafe → false', () => {
    expect(collatorCompare('==', 'CAFE', 'cafe', '', true, false)).toBe(false)
  })
  it('case-sensitive: CAFE != cafe → true', () => {
    expect(collatorCompare('!=', 'CAFE', 'cafe', '', true, false)).toBe(true)
  })
})

describe('collatorCompare — diacritic sensitivity', () => {
  it('diacritic-insensitive (default): café == cafe → true', () => {
    expect(collatorCompare('==', 'café', 'cafe', '', false, false)).toBe(true)
  })
  it('diacritic-sensitive: café == cafe → false', () => {
    expect(collatorCompare('==', 'café', 'cafe', '', false, true)).toBe(false)
  })
  it('case-sensitive but diacritic-insensitive: café == cafe → true, CAFÉ == cafe → false', () => {
    expect(collatorCompare('==', 'café', 'cafe', '', true, false)).toBe(true)
    expect(collatorCompare('==', 'CAFÉ', 'cafe', '', true, false)).toBe(false)
  })
})

describe('collatorCompare — ordering operators', () => {
  it('a < b → true, b < a → false', () => {
    expect(collatorCompare('<', 'a', 'b', '', true, true)).toBe(true)
    expect(collatorCompare('<', 'b', 'a', '', true, true)).toBe(false)
  })
  it('>= is reflexive for equivalent strings', () => {
    expect(collatorCompare('>=', 'a', 'A', '', false, false)).toBe(true)
  })
})

describe('collatorCompare — robustness', () => {
  it('non-string operands are stringified', () => {
    expect(collatorCompare('==', 5, '5', '', false, false)).toBe(true)
  })
  it('malformed locale falls back instead of throwing', () => {
    expect(() => collatorCompare('==', 'a', 'a', 'not a locale!!', false, false)).not.toThrow()
    expect(collatorCompare('==', 'a', 'a', 'not a locale!!', false, false)).toBe(true)
  })
})

describe('resolvedLocale', () => {
  it('canonicalises a well-formed tag', () => {
    expect(resolvedLocale('en-US')).toMatch(/^en/i)
  })
  it('empty locale resolves to a non-empty default tag', () => {
    expect(resolvedLocale('')).toMatch(/[a-z]/i)
  })
  it('malformed locale falls back to a default, no throw', () => {
    expect(() => resolvedLocale('!!bad!!')).not.toThrow()
    expect(resolvedLocale('!!bad!!')).toMatch(/[a-z]/i)
  })
})
