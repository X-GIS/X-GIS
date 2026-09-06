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

// Every `valueKind: 'enum'` property, keyed `<construct>.<key>`, rendered into the
// source a REAL consumer writes for one option — the blueprint editor's emitter
// (`blueprint/src/codegen.ts`), the schema's only consumer, whose block shapes these
// mirror. Parsing ONE minimal sample per construct never touched a property's
// `options`, so an enum could advertise a value the grammar rejects outright and stay
// green: `symbol { anchor: top-left }` is a hard ParseError, since the grammar's anchor
// value is an IDENT and identifiers carry no hyphen (#2548). Adding an enum property
// without a renderer here fails the coverage assertion below.
const ENUM_SAMPLES: Record<string, (option: string) => string> = {
  // `mode` selects the import SHAPE rather than appearing as a literal — the two forms
  // `emitImport` writes.
  'import.mode': (o) => (o === 'named' ? 'import { a } from "lib.xgis"' : 'import "lib.xgis"'),
  'source.type': (o) => `source s {\n  type: ${o}\n}`,
  'symbol.anchor': (o) => `symbol sym {\n  path "M 0 0 L 1 1 Z"\n  anchor: ${o}\n}`,
  // `default` must be a literal of the declared type — checked at parse time.
  'input.type': (o) => `input threshold: ${o} = ${o === 'color' ? '#3b82f6' : '0.5'}`,
}

/** `<construct>.<key>` for every enum-valued property the schema declares. */
const enumPaths = Object.entries(LANGUAGE_SCHEMA).flatMap(([keyword, def]) =>
  def.properties.filter((p) => p.valueKind === 'enum').map((p) => `${keyword}.${p.key}`),
)

describe('LANGUAGE_SCHEMA enum options are real grammar values', () => {
  it('every enum property has an option renderer (no drift)', () => {
    expect(enumPaths.slice().sort()).toEqual(Object.keys(ENUM_SAMPLES).sort())
  })

  for (const [keyword, def] of Object.entries(LANGUAGE_SCHEMA)) {
    for (const prop of def.properties) {
      if (prop.valueKind !== 'enum') continue
      const render = ENUM_SAMPLES[`${keyword}.${prop.key}`]
      for (const option of prop.options ?? []) {
        it(`${keyword}.${prop.key}: the advertised \`${option}\` parses`, () => {
          expect(render).toBeDefined()
          const src = render!(option)
          const program = new Parser(new Lexer(withPragma(src)).tokenize()).parse()
          expect(program.body.map((s) => s.kind)).toContain(def.astKind)
        })
      }
    }
  }

  it("the symbol block's anchor options ARE the lowering's SYMBOL_ANCHORS (one authority)", () => {
    // Identity, not equality: a re-copied literal list is exactly how the schema drifted
    // to nine values while the grammar and `isSymbolAnchor` took five (#2548).
    const anchor = LANGUAGE_SCHEMA.symbol!.properties.find((p) => p.key === 'anchor')!
    expect(anchor.options).toBe(SYMBOL_ANCHORS)
  })
})

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
