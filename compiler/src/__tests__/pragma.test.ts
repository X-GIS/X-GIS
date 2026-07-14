// ═══ Mandatory `xgis <major>` version pragma — parser gate (#1064) ═══
//
// The pragma is the gate for every future language breaking change: a
// `.xgis` source MUST open with `xgis <major>` (comments/blank lines may
// precede it — the lexer strips them, so it need only be the first
// *token*). The parser hard-errors on a missing/malformed pragma
// (X-GIS0008) and on a MAJOR newer than this compiler implements
// (X-GIS0009). `convertMapboxStyle` emits the pragma as its first line.

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { XGIS_LANGUAGE_MAJOR } from '../language-version'

/** Parse WITHOUT a helper-injected pragma — these tests own the pragma. */
function parse(source: string) {
  return new Parser(new Lexer(source).tokenize()).parse()
}

describe('version pragma — accepted forms', () => {
  it('`xgis 1` as the first statement parses', () => {
    const ast = parse(
      `xgis ${XGIS_LANGUAGE_MAJOR}\nsource world { type: geojson, url: "w.geojson" }`,
    )
    expect(ast.kind).toBe('Program')
    // The pragma is consumed, NOT surfaced as a body statement.
    expect(ast.body).toHaveLength(1)
    expect(ast.body[0].kind).toBe('SourceStatement')
  })

  it('a bare `xgis 1` (no other statements) parses to an empty program', () => {
    const ast = parse(`xgis ${XGIS_LANGUAGE_MAJOR}`)
    expect(ast.body).toHaveLength(0)
  })

  it('line + block comments and blank lines may precede the pragma', () => {
    const ast = parse(
      `// title\n\n/* multi\n   line */\nxgis ${XGIS_LANGUAGE_MAJOR}\nsource w { type: geojson, url: "w.geojson" }`,
    )
    expect(ast.body).toHaveLength(1)
    expect(ast.body[0].kind).toBe('SourceStatement')
  })
})

describe('version pragma — rejected forms', () => {
  it('a missing pragma is a hard error naming the fix', () => {
    let err: Error | null = null
    try {
      parse(`source world { type: geojson, url: "w.geojson" }`)
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
    expect(err!.message).toContain('X-GIS0008')
    expect(err!.message).toContain(`xgis ${XGIS_LANGUAGE_MAJOR}`)
    expect(err!.message).toContain('first statement')
  })

  it('the empty source is a missing-pragma hard error', () => {
    expect(() => parse('')).toThrow('X-GIS0008')
  })

  it('a pragma AFTER a statement is rejected (it is not first)', () => {
    expect(() =>
      parse(`source world { type: geojson, url: "w.geojson" }\nxgis ${XGIS_LANGUAGE_MAJOR}`),
    ).toThrow('X-GIS0008')
  })

  it('a newer MAJOR (`xgis 2`) is rejected as written for a newer X-GIS', () => {
    let err: Error | null = null
    try {
      parse(`xgis ${XGIS_LANGUAGE_MAJOR + 1}\nsource w { type: geojson, url: "w.geojson" }`)
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
    expect(err!.message).toContain('X-GIS0009')
    expect(err!.message).toContain('newer X-GIS')
  })

  it('`xgis` with no version number is rejected', () => {
    expect(() => parse('xgis\nsource w { type: geojson, url: "w.geojson" }')).toThrow('X-GIS0008')
  })

  it('a non-integer major (`xgis 1.0`) is rejected — the pragma is major-only', () => {
    expect(() => parse('xgis 1.0\nsource w { type: geojson, url: "w.geojson" }')).toThrow(
      'X-GIS0008',
    )
  })

  it('a zero / sub-1 major is rejected', () => {
    expect(() => parse('xgis 0\nsource w { type: geojson, url: "w.geojson" }')).toThrow('X-GIS0008')
  })
})

describe('convertMapboxStyle emits the pragma', () => {
  const MINIMAL = {
    version: 8,
    name: 'minimal',
    sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#000' } },
      { id: 'l', type: 'fill', source: 's', paint: { 'fill-color': '#f00' } },
    ],
  }

  it('output starts with `xgis <major>` as the first line', () => {
    const out = convertMapboxStyle(MINIMAL)
    expect(out.startsWith(`xgis ${XGIS_LANGUAGE_MAJOR}\n`)).toBe(true)
  })

  it('converted output round-trips through the parser gate', () => {
    const out = convertMapboxStyle(MINIMAL)
    // Would throw X-GIS0008 if the converter had not emitted the pragma.
    expect(() => parse(out)).not.toThrow()
  })
})
