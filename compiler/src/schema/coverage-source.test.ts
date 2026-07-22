// ═══ `coverage` source type — grammar + schema pin (#1158 GAP-1 INC-A / A9) ═══
//
// Pins the exact `.xgis` syntax for an S-100 coverage source and the SOURCE_TYPES
// membership that makes it a BUILT-IN (auto-propagated to @xgis/map's
// BUILTIN_SOURCE_TYPES). Adding 'coverage' here does NOT trip the spec-coverage ↔
// RUNTIME_CAPABILITIES drift gate — the Mapbox converter's spec-coverage table is a
// separate authority (A9). ramp/range ride as additive SOURCE-level options (doc §6).

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { withPragma } from '../__tests__/_pragma'
import { SOURCE_TYPES, LANGUAGE_SCHEMA } from './language'
import { lower } from '../ir/lower'
import type * as AST from '../parser/ast'

function parseFirstSource(src: string): AST.SourceStatement {
  const program = new Parser(new Lexer(withPragma(src)).tokenize()).parse()
  const stmt = program.body.find((s) => s.kind === 'SourceStatement')
  if (!stmt) throw new Error('no SourceStatement parsed')
  return stmt as AST.SourceStatement
}

describe('coverage source: grammar + schema (A9)', () => {
  it('parses `source { type: coverage, url, ramp, range: [lo, hi] }` (exact syntax pinned)', () => {
    const s = parseFirstSource(
      'source bathy { type: coverage, url: "SEA_S102_2026.h5", ramp: "bathymetry", range: [0, 40] }',
    )
    expect(s.name).toBe('bathy')
    const byName = new Map(s.properties.map((p) => [p.name, p.value]))
    expect([...byName.keys()].sort()).toEqual(['ramp', 'range', 'type', 'url'])

    const type = byName.get('type')!
    expect(type.kind).toBe('Identifier')
    expect((type as AST.Identifier).name).toBe('coverage')

    const url = byName.get('url')!
    expect(url.kind).toBe('StringLiteral')
    expect((url as AST.StringLiteral).value).toBe('SEA_S102_2026.h5')

    const ramp = byName.get('ramp')!
    expect(ramp.kind).toBe('StringLiteral')
    expect((ramp as AST.StringLiteral).value).toBe('bathymetry')

    const range = byName.get('range')!
    expect(range.kind).toBe('ArrayLiteral')
    const els = (range as AST.ArrayLiteral).elements
    expect(els.map((e) => (e as AST.NumberLiteral).value)).toEqual([0, 40])
  })

  it("'coverage' is a grammar SOURCE_TYPE (→ built-in via BUILTIN_SOURCE_TYPES)", () => {
    expect(SOURCE_TYPES).toContain('coverage')
    // Mirror @xgis/map's derivation: BUILTIN_SOURCE_TYPES = SOURCE_TYPES + 'xgvt'.
    const builtin = new Set<string>([...SOURCE_TYPES, 'xgvt'])
    expect(builtin.has('coverage')).toBe(true)
    // An unknown type is NOT built-in → routes to the per-map custom-loader registry.
    expect(builtin.has('x-kr-admin')).toBe(false)
  })

  it('the schema `source` construct advertises the additive ramp/range options', () => {
    const keys = LANGUAGE_SCHEMA.source!.properties.map((p) => p.key)
    expect(keys).toContain('ramp')
    expect(keys).toContain('range')
    // `type` enum options include coverage (the editor/palette single-authority)
    const typeProp = LANGUAGE_SCHEMA.source!.properties.find((p) => p.key === 'type')!
    expect(typeProp.options).toContain('coverage')
  })
})

describe('coverage source: hdf5/h5 are format-name aliases (canonicalise → coverage)', () => {
  // The exact mirror of `pmtiles`/`tilejson` under `vector`: a container name is a
  // first-class spelling of the render family, canonicalised to the role name at the
  // ONE lowering chokepoint so the IR + dead-layer-elim + runtime only see `coverage`.
  function lowerFirstSource(src: string) {
    const program = new Parser(new Lexer(withPragma(src)).tokenize()).parse()
    return lower(program).sources
  }
  it.each(['hdf5', 'h5'])('`type: %s` lowers to a coverage SourceDef (role name)', (alias) => {
    const [src] = lowerFirstSource(
      `source cur { type: ${alias}, url: "cbofs.h5" }\nlayer l { source: cur }`,
    )
    expect(src!.name).toBe('cur')
    expect(src!.type).toBe('coverage')
  })
  it('`hdf5`/`h5` are grammar SOURCE_TYPES (bare identifier parses → built-in)', () => {
    expect(SOURCE_TYPES).toContain('hdf5')
    expect(SOURCE_TYPES).toContain('h5')
    const builtin = new Set<string>([...SOURCE_TYPES, 'xgvt'])
    expect(builtin.has('hdf5')).toBe(true)
    expect(builtin.has('h5')).toBe(true)
  })
})
