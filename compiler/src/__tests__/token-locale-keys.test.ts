// #2310 — Mapbox token strings whose keys are NOT identifier-shaped.
//
// `"{name:latin}\n{name:nonlatin}"` is the canonical OpenMapTiles bilingual
// label (osm-bright, positron, dark-matter, klokantech-basic, maptiler-basic).
// The converter used to emit it verbatim as a quoted xgis template, and the
// template parser reads a `:` at depth 1 as a FORMAT-SPEC separator — so
// `parseFormatSpec("latin")` threw `format spec: unknown type "l"` out of
// lower(), taking the ENTIRE scene with it: the water fill and the roads in the
// same style are lost too, not just the symbol layer.
//
// The expression twin `["concat", ["get","name:latin"], …]` already lowered
// correctly (country-label-expression.test.ts), so the token-string spelling was
// the only broken one — and it is the spelling those five styles actually ship.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

function styleWithTextField(field: unknown) {
  return {
    version: 8,
    sources: { v: { type: 'vector', url: 'a.pmtiles' } },
    layers: [
      {
        id: 'place',
        type: 'symbol',
        source: 'v',
        'source-layer': 'place',
        layout: { 'text-field': field } as never,
        paint: { 'text-color': '#000000' },
      },
    ],
  }
}

function lowerOrThrow(src: string) {
  return lower(new Parser(new Lexer(src).tokenize()).parse())
}

describe('#2310 — non-identifier token keys', () => {
  it('a multi-token locale text-field lowers instead of throwing out of lower()', () => {
    const out = convertMapboxStyle(styleWithTextField('{name:latin}\n{name:nonlatin}'))
    // Fail-before: this threw `format spec: unknown type "l" at "latin"`.
    expect(() => lowerOrThrow(out)).not.toThrow()
    expect(out).toContain('get("name:latin")')
    expect(out).toContain('get("name:nonlatin")')
  })

  it('a single non-identifier token keeps its key instead of collapsing to .name', () => {
    const out = convertMapboxStyle(styleWithTextField('{name:latin}'))
    expect(out).toContain('get("name:latin")')
    expect(() => lowerOrThrow(out)).not.toThrow()
  })

  // Control: the identifier-shaped forms must be untouched by the fix — a token
  // string of plain keys still emits the cheap FieldAccess / quoted template,
  // not a concat() chain.
  it('control — an identifier-shaped single token still emits a FieldAccess', () => {
    const out = convertMapboxStyle(styleWithTextField('{name}'))
    expect(out).toContain('.name')
    expect(out).not.toContain('get("name")')
  })

  it('control — an identifier-shaped multi-token template is still emitted verbatim', () => {
    const out = convertMapboxStyle(styleWithTextField('{name}\n{ele}'))
    expect(out).toContain('"{name}\\n{ele}"')
    expect(out).not.toContain('concat(')
    expect(() => lowerOrThrow(out)).not.toThrow()
  })
})
