// BUG 8 — the trailing-unit capture for bracketed utility bindings
// recognized only px/m/km/nm/deg, omitting the s/ms time units that
// the units table and parsePrimary already support. So `duration-[t]ms`
// dropped the unit (bindingUnit stayed null) and the leftover `ms`
// became a phantom utility item.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import type * as AST from '../parser/ast'
import { withPragma } from './_pragma'

function parse(source: string): AST.Program {
  const tokens = new Lexer(withPragma(source)).tokenize()
  return new Parser(tokens).parse()
}

describe('BUG 8 — s/ms units on bracketed utility bindings', () => {
  it('captures `ms` as the binding unit instead of leaking a phantom item', () => {
    const ast = parse('layer L { | duration-[t]ms opacity-50 }')
    const layer = ast.body[0] as AST.LayerStatement
    expect(layer.kind).toBe('LayerStatement')
    const items = layer.utilities[0].items
    expect(items).toHaveLength(2)
    expect(items[0].name).toBe('duration')
    expect(items[0].bindingUnit).toBe('ms')
    expect(items[1].name).toBe('opacity-50')
  })

  it('captures `s` as the binding unit too', () => {
    const ast = parse('layer L { | delay-[d]s }')
    const layer = ast.body[0] as AST.LayerStatement
    const items = layer.utilities[0].items
    expect(items).toHaveLength(1)
    expect(items[0].bindingUnit).toBe('s')
  })
})
