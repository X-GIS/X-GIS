import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import type * as AST from './ast'

// Regression for: match() arm whose value is a case/ternary emits xgis the
// parser cannot parse. The converter (convert/expressions.ts) renders a
// Mapbox ["case", ...] arm as a ternary `cond ? a : b`, but parseMatchBlock
// read arm values with parseCoalesce() — below ternary precedence — so the
// `?` was left unconsumed and `expect(RBrace)` threw, failing the whole
// program parse (the per-layer try/catch does not contain it).
function parseExpr(src: string): AST.Expr {
  const tokens = new Lexer(src).tokenize()
  return new Parser(tokens).parseSingleExpression()
}

describe('match arm with ternary/case value', () => {
  // This is exactly what convert/expressions.ts emits for
  // ["match",["get","type"],"a",["case",["==",["get","x"],1],"#ff0000","#0000ff"],"#00ff00"]
  const src = 'match(.type) { "a" -> .x == 1 ? "#ff0000" : "#0000ff", _ -> "#00ff00" }'

  it('parses without throwing', () => {
    // On clean HEAD this throws: [Parser] Expected RBrace, got Question
    expect(() => parseExpr(src)).not.toThrow()
  })

  it('produces a match FnCall whose first arm value is a ConditionalExpr', () => {
    const expr = parseExpr(src) as AST.FnCall
    expect(expr.kind).toBe('FnCall')
    expect((expr.callee as AST.Identifier).name).toBe('match')
    const block = expr.matchBlock as AST.MatchBlock
    expect(block.kind).toBe('MatchBlock')
    expect(block.arms).toHaveLength(2)

    // arm 0: "a" -> ( .x == 1 ? "#ff0000" : "#0000ff" )
    expect(block.arms[0].pattern).toBe('a')
    const cond = block.arms[0].value as AST.ConditionalExpr
    expect(cond.kind).toBe('ConditionalExpr')
    expect((cond.condition as AST.BinaryExpr).op).toBe('==')
    expect((cond.thenExpr as AST.ColorLiteral).value).toBe('#ff0000')
    expect((cond.elseExpr as AST.ColorLiteral).value).toBe('#0000ff')

    // arm 1: default _ -> "#00ff00"
    expect(block.arms[1].pattern).toBe('_')
    expect((block.arms[1].value as AST.ColorLiteral).value).toBe('#00ff00')
  })
})
