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

describe('fn statement grammar (#1535 step 8)', () => {
  function firstFn(source: string): AST.FnStatement {
    const stmt = parse(source).body.find((s) => s.kind === 'FnStatement')
    if (!stmt) throw new Error('no FnStatement parsed')
    return stmt as AST.FnStatement
  }

  it('parses an expression-bodied fn declaration', () => {
    const f = firstFn('fn halo(width, base) { return clamp(width * 1.5 + base, 1, 24) }')
    expect(f.name).toBe('halo')
    expect(f.params).toEqual(['width', 'base'])
    expect(f.body).toMatchObject({ kind: 'FnCall', callee: { name: 'clamp' } })
  })

  it('parses a zero-param fn', () => {
    const f = firstFn('fn tau() { return PI() * 2 }')
    expect(f.params).toEqual([])
  })

  it('ternary bodies parse (the v1 branching form)', () => {
    const f = firstFn('fn pick(x) { return x > 10 ? 1 : 0 }')
    expect(f.body.kind).toBe('ConditionalExpr')
  })

  it('imperative bodies are rejected (pre-#1072 grammar stays dead)', () => {
    expect(() => parse('fn scale(x) { let y = x * 2 return y }')).toThrow()
  })

  it('a body without return is rejected', () => {
    expect(() => parse('fn scale(x) { x * 2 }')).toThrow()
  })
})
