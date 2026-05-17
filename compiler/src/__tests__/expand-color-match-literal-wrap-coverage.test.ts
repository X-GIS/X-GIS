// Pin v8-strict `["literal", [v1, v2]]` unwrap on the keys-array
// form inside expandPerFeatureColorMatch. Pre-fix the outer
// Array.isArray check passed and the iteration consumed "literal" +
// the inner array as if they were keys, bailing on the typeof
// check — the expand returned null and the layer fell to lower.ts's
// pick-first-stop fallback, rendering ONE colour for every feature
// instead of the per-feature palette.

import { describe, it, expect } from 'vitest'
import { expandPerFeatureColorMatch } from '../convert/expand-color-match'
import type { MapboxLayer } from '../convert/types'

function buildLayer(matchArgs: unknown[]): MapboxLayer {
  return {
    id: 'l',
    type: 'fill',
    source: 'v',
    'source-layer': 'water',
    paint: {
      'fill-color': ['match', ['get', 'kind'], ...matchArgs] as never,
    },
  } as MapboxLayer
}

describe('expandPerFeatureColorMatch — v8 literal-wrap on keys', () => {
  it('bare keys-array splits into one sublayer per colour', () => {
    const expanded = expandPerFeatureColorMatch(buildLayer([
      ['ocean', 'sea'], '#001',
      ['lake', 'pond'], '#0a0',
      '#888',
    ]))
    expect(expanded).not.toBeNull()
    expect(expanded!.length).toBe(3)  // 2 colour buckets + default
    // First sublayer carries the ocean/sea filter.
    const filters = expanded!.map(l => l.filter)
    expect(JSON.stringify(filters[0])).toContain('"ocean"')
    expect(JSON.stringify(filters[0])).toContain('"sea"')
  })

  it('wrapped ["literal", ["ocean","sea"]] keys ALSO splits correctly', () => {
    // Pre-fix the wrap defeated typeof check and the whole expand
    // returned null; the layer rendered the FIRST colour for every
    // feature instead of per-class palette.
    const expanded = expandPerFeatureColorMatch(buildLayer([
      ['literal', ['ocean', 'sea']], '#001',
      ['literal', ['lake', 'pond']], '#0a0',
      '#888',
    ]))
    expect(expanded).not.toBeNull()
    expect(expanded!.length).toBe(3)
    const filters = expanded!.map(l => l.filter)
    expect(JSON.stringify(filters[0])).toContain('"ocean"')
    expect(JSON.stringify(filters[0])).toContain('"sea"')
    expect(JSON.stringify(filters[1])).toContain('"lake"')
    expect(JSON.stringify(filters[1])).toContain('"pond"')
    // The emitted filters use `["in", field, ["literal", [...]]]`
    // shape — "literal" appears as legitimate operator in the
    // emitted filters; we just need the inner key list to NOT
    // contain "literal" as a key value.
    for (const f of filters) {
      const fs = JSON.stringify(f)
      // No "literal" as a key — the operator string itself can
      // appear but never as one of the iterated key values.
      expect(fs).not.toMatch(/"ocean","literal"|"literal","ocean"/)
    }
  })

  it('mixed bare + wrapped keys both unwrap correctly', () => {
    const expanded = expandPerFeatureColorMatch(buildLayer([
      'ocean', '#001',
      ['literal', ['lake', 'pond']], '#0a0',
      '#888',
    ]))
    expect(expanded).not.toBeNull()
    expect(expanded!.length).toBe(3)
  })
})
