// ═══ struct source schemas (#1537) — checked `.field` access ═══
// Opt-in: a source that declares `schema:` gets its layers' field
// accesses checked against the struct; an unannotated source keeps
// today's fully dynamic behaviour.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import type * as AST from '../parser/ast'
import { withPragma } from './_pragma'
import { lower } from '../ir/lower'

function parse(source: string): AST.Program {
  return new Parser(new Lexer(withPragma(source)).tokenize()).parse()
}

const errs = (src: string) =>
  (lower(parse(src)).diagnostics ?? []).filter((d) => d.severity === 'error')

const SCHEMA = 'struct Track { speed: f32, heading: f32, name: string }'

describe('struct declarations (#1537)', () => {
  it('parses a struct into typed fields', () => {
    const s = parse(SCHEMA).body.find((x) => x.kind === 'StructStatement') as AST.StructStatement
    expect(s.name).toBe('Track')
    expect(s.fields).toEqual([
      { name: 'speed', type: 'f32' },
      { name: 'heading', type: 'f32' },
      { name: 'name', type: 'string' },
    ])
  })

  it('an unknown field type is rejected at parse time', () => {
    expect(() => parse('struct T { a: quaternion }')).toThrow()
  })

  it('`struct` stays usable inside hyphen-joined utility names', () => {
    // The keyword trap: `preset`/`fn`/`from`/`to` all had to be re-admitted
    // to the utility-name accumulator; `struct` is no different.
    const items = (
      parse(`
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | struct-outline-2 }
`).body.find((x) => x.kind === 'LayerStatement') as AST.LayerStatement
    ).utilities.flatMap((l) => l.items)
    expect(items.map((i) => i.name)).toEqual(['struct-outline-2'])
  })
})

describe('checked field access (#1537)', () => {
  const scene = (binding: string, filter = '') => `
${SCHEMA}
source ais { type: geojson, url: "ais.geojson", schema: Track }
layer boats {
  source: ais
  ${filter}
  | size-[${binding}]
}
`

  it('a declared field is accepted', () => {
    expect(errs(scene('.speed * 2'))).toEqual([])
  })

  it('a typo is X-GIS0019 with a nearest-name suggestion', () => {
    const d = errs(scene('.speeed * 2'))
    expect(d.map((x) => x.code)).toContain('X-GIS0019')
    expect(d[0]!.help).toContain('speed')
  })

  it('the check reaches `filter:` expressions too', () => {
    expect(errs(scene('.speed', 'filter: .headng > 90')).map((x) => x.code)).toContain('X-GIS0019')
  })

  it('reserved camera/geometry keys are never flagged as fields', () => {
    expect(errs(scene('.speed', 'filter: get("$geometryType") == "Point"'))).toEqual([])
  })

  it('an UNANNOTATED source keeps fully dynamic access (opt-in, no regression)', () => {
    expect(
      errs(`
source ais { type: geojson, url: "ais.geojson" }
layer boats { source: ais  | size-[.anything_at_all] }
`),
    ).toEqual([])
  })

  it('an unknown schema name on a source is itself an error', () => {
    expect(
      errs(`
source ais { type: geojson, url: "ais.geojson", schema: Nope }
layer boats { source: ais  | size-[.x] }
`).map((x) => x.code),
    ).toContain('X-GIS0019')
  })
})
