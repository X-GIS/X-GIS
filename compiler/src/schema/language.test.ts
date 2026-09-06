import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { LANGUAGE_SCHEMA } from './language'
import { SYMBOL_ANCHORS } from '../ir/symbol-elements'
import { withPragma } from '../__tests__/_pragma'

// A minimal, must-parse block per construct. Adding a construct to
// LANGUAGE_SCHEMA without a sample here fails the coverage assertion,
// so the schema cannot silently drift from the real grammar.
const SAMPLES: Record<string, string> = {
  import: 'import "lib.xgis"',
  source: 'source s { type: geojson }',
  symbol: 'symbol sym { path "M 0 0 L 1 1 Z" }',
  preset: 'preset p(a) { | fill-[a] }',
  fn: 'fn halo(w) { return clamp(w, 1, 24) }',
  struct: 'struct Track { speed: f32, name: string }',
  input: 'input threshold: f32 = 0.5',
  layer: 'layer l { | fill-red-500 }',
  background: 'background { fill: sky-900 }',
}

// A source that USES one advertised `options` value, per enum property (#2548).
// The sample above proves the construct parses; it says nothing about what a
// property's enum may contain, so an enum could advertise a value the grammar
// rejects outright and stay green — which it did: `symbol { anchor: … }` offered
// four corner values that are hard parse errors, because the grammar reads the
// anchor as a single IDENT and `-` is not an identifier character.
//
// Keyed `<keyword>.<key>`; the builders hold SYNTAX PLACEMENT only. The value
// list stays the schema's, so this cannot become a second authority on it.
const ENUM_SAMPLES: Record<string, (value: string) => string> = {
  // `mode` is structural rather than a `key: value` pair — the shape of the
  // statement IS the mode (parser-statements.ts parseImportStatement).
  'import.mode': (v) => (v === 'named' ? 'import { roads } from "lib.xgis"' : 'import "lib.xgis"'),
  'source.type': (v) => `source s { type: ${v} }`,
  'symbol.anchor': (v) => `symbol sym { path "M 0 0 L 1 1 Z" anchor: ${v} }`,
  'input.type': (v) => `input threshold: ${v} = ${v === 'color' ? '#ffffff' : '0.5'}`,
}

/** Every `valueKind: 'enum'` property in the schema, as `<keyword>.<key>`. */
const enumProps = Object.entries(LANGUAGE_SCHEMA).flatMap(([keyword, def]) =>
  def.properties
    .filter((p) => p.valueKind === 'enum')
    .map((p) => ({ keyword, key: p.key, id: `${keyword}.${p.key}`, options: p.options ?? [] })),
)

describe('LANGUAGE_SCHEMA conformance', () => {
  it('every construct has a parse sample (no drift)', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(LANGUAGE_SCHEMA).sort())
  })

  for (const [keyword, def] of Object.entries(LANGUAGE_SCHEMA)) {
    it(`${keyword}: keyword matches and a minimal block parses to ${def.astKind}`, () => {
      expect(def.keyword).toBe(keyword)
      const src = SAMPLES[keyword]
      const program = new Parser(new Lexer(withPragma(src)).tokenize()).parse()
      const kinds = program.body.map((s) => s.kind)
      expect(kinds).toContain(def.astKind)
    })
  }

  it('every enum property has a usage sample (no drift)', () => {
    expect(enumProps.map((e) => e.id).sort()).toEqual(Object.keys(ENUM_SAMPLES).sort())
  })

  for (const { id, options } of enumProps) {
    it(`${id}: every advertised option parses`, () => {
      expect(options.length).toBeGreaterThan(0)
      const rejected: string[] = []
      for (const option of options) {
        const src = ENUM_SAMPLES[id](option)
        try {
          new Parser(new Lexer(withPragma(src)).tokenize()).parse()
        } catch (e) {
          rejected.push(`${option} → ${(e as Error).message}`)
        }
      }
      // An editor or dropdown driven by the schema emits these verbatim, so a
      // value the grammar rejects produces an uncompilable document (#2548).
      expect(rejected).toEqual([])
    })
  }

  // The lowering is the single authority on which anchors exist
  // (ir/symbol-elements.ts SYMBOL_ANCHORS, gating isSymbolAnchor), and the
  // grammar agrees with it. `toBe` — not `toEqual` — on purpose: the schema must
  // DERIVE from that array, because a second literal copy with equal contents is
  // exactly the drift that shipped the four unparseable corner anchors (#2548).
  it('the symbol block advertises the lowering’s anchors, by reference', () => {
    const anchor = LANGUAGE_SCHEMA.symbol.properties.find((p) => p.key === 'anchor')
    expect(anchor?.options).toBe(SYMBOL_ANCHORS)
  })

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
