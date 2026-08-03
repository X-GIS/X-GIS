// ═══ User-defined `fn` (#1535) — reintroduction test corpus ═══
// Grows step-by-step with the feature: step 7 pins the lexer-keyword
// hazards (the documented `fn-*` utility-name trap), later steps add
// the statement grammar, name resolution, and the inline pass.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import type * as AST from '../parser/ast'
import { withPragma } from './_pragma'

function parse(source: string): AST.Program {
  const tokens = new Lexer(withPragma(source)).tokenize()
  return new Parser(tokens).parse()
}

function layerItems(source: string): AST.UtilityItem[] {
  const stmt = parse(source).body.find((s) => s.kind === 'LayerStatement') as
    AST.LayerStatement | undefined
  if (!stmt) throw new Error('no LayerStatement parsed')
  return stmt.utilities.flatMap((l) => l.items)
}

describe('fn keyword — utility-name re-admission (#1535 step 7)', () => {
  // The documented keyword trap: a keyword usable inside a hyphen-joined
  // utility name must be re-admitted in isUtilityNameToken AND the
  // mid-name continuation list, or the name accumulator short-circuits.
  // (`preset`/`from`/`to` already live there for the same reason.)
  it('a leading `fn-` utility name still parses after fn became a keyword', () => {
    const items = layerItems(`
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | fn-foo-2 opacity-80 }
`)
    expect(items.map((i) => i.name)).toEqual(['fn-foo-2', 'opacity-80'])
  })

  it('a mid-name `-fn-` segment still parses', () => {
    const items = layerItems(`
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | shape-fn-star }
`)
    expect(items.map((i) => i.name)).toEqual(['shape-fn-star'])
  })
})
