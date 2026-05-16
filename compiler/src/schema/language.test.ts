import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { LANGUAGE_SCHEMA } from './language'

// A minimal, must-parse block per construct. Adding a construct to
// LANGUAGE_SCHEMA without a sample here fails the coverage assertion,
// so the schema cannot silently drift from the real grammar.
const SAMPLES: Record<string, string> = {
  import: 'import "lib.xgis"',
  source: 'source s { type: geojson }',
  symbol: 'symbol sym { path "M 0 0 L 1 1 Z" }',
  style: 'style st { fill: stone-800 }',
  preset: 'preset p { | fill-red-500 }',
  fn: 'fn f(level: f32) -> f32 { return level }',
  layer: 'layer l { | fill-red-500 }',
  background: 'background { fill: sky-900 }',
}

describe('LANGUAGE_SCHEMA conformance', () => {
  it('every construct has a parse sample (no drift)', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(LANGUAGE_SCHEMA).sort())
  })

  for (const [keyword, def] of Object.entries(LANGUAGE_SCHEMA)) {
    it(`${keyword}: keyword matches and a minimal block parses to ${def.astKind}`, () => {
      expect(def.keyword).toBe(keyword)
      const src = SAMPLES[keyword]
      const program = new Parser(new Lexer(src).tokenize()).parse()
      const kinds = program.body.map((s) => s.kind)
      expect(kinds).toContain(def.astKind)
    })
  }

  it('refs only target real producing constructs', () => {
    const produced = new Set(
      Object.values(LANGUAGE_SCHEMA)
        .map((d) => d.produces)
        .filter(Boolean),
    )
    for (const def of Object.values(LANGUAGE_SCHEMA)) {
      for (const ref of def.refs ?? []) {
        expect(produced.has(ref.refType)).toBe(true)
      }
    }
  })
})
