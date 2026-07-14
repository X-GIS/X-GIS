// BUG 7 — a trailing comma after the last value in a show property
// threw `[Parser] Unexpected token: } (RBrace)`. The comma loop in
// parseShowProperty only stopped on a property-separator lookahead
// (isNextPropertyStart); a trailing comma before `}` fell through to
// the value-separator branch and parseExpr() ran at `}`. Trailing
// commas are already tolerated in arg lists and array literals.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import type * as AST from '../parser/ast'
import { withPragma } from './_pragma'

function parse(source: string): AST.Program {
  const tokens = new Lexer(withPragma(source)).tokenize()
  return new Parser(tokens).parse()
}

describe('BUG 7 — trailing comma in a show property', () => {
  it('does not throw on a trailing comma before }', () => {
    expect(() => parse('show w { stroke: a, }')).not.toThrow()
  })

  it('keeps just the single value (the trailing comma adds nothing)', () => {
    const ast = parse('show w { stroke: a, }')
    const show = ast.body[0] as AST.ShowStatement
    expect(show.kind).toBe('ShowStatement')
    const prop = show.block.properties[0]
    expect(prop.name).toBe('stroke')
    expect(prop.values).toHaveLength(1)
    expect((prop.values[0] as AST.Identifier).kind).toBe('Identifier')
    expect((prop.values[0] as AST.Identifier).name).toBe('a')
  })

  it('still parses a genuine multi-value property', () => {
    const ast = parse('show w { stroke: a, 1px }')
    const show = ast.body[0] as AST.ShowStatement
    expect(show.block.properties[0].values).toHaveLength(2)
  })
})
