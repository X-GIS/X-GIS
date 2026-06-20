import { TokenType, type Token } from '../lexer/tokens'
import { Lexer } from '../lexer/lexer'
import type * as AST from './ast'
import { StatementParser } from './parser-statements'

/** Parse a standalone xgis expression string into an AST.Expr.
 *  Used by the IR lower pass to re-parse expression sources
 *  embedded in string templates (the bit between `{` and `}` in
 *  `"Lat: {lat:.4f}°N"`). Throws if the source has trailing
 *  tokens beyond a single expression. */
export function parseExpressionString(source: string): AST.Expr {
  const tokens = new Lexer(source).tokenize()
  const p = new Parser(tokens)
  return p.parseSingleExpression()
}

/** Thin recursive-descent driver. The statement handlers + keyword
 *  registry (parser-statements.ts), the expression precedence ladder
 *  (parser-expressions.ts), and the shared token cursor
 *  (parser-cursor.ts) live in their own modules; `Parser` only wires
 *  the public entry points (`parse`, `parseSingleExpression`) on top
 *  of that shared cursor. */
export class Parser extends StatementParser {
  constructor(tokens: Token[]) {
    super(tokens)
  }

  parse(): AST.Program {
    const body: AST.Statement[] = []
    while (!this.isEnd()) {
      body.push(this.parseStatement())
    }
    return { kind: 'Program', body }
  }

  /** Parse a single expression and verify nothing else follows.
   *  Public entry point for sub-expressions (template interps,
   *  programmatic builders). */
  parseSingleExpression(): AST.Expr {
    const expr = this.parseExpr()
    if (!this.isEnd()) {
      const tok = this.current()
      throw new Error(
        `Expected end of expression, got ${TokenType[tok.type]} ` +
        `'${tok.value}' at line ${tok.line}, col ${tok.col}`,
      )
    }
    return expr
  }
}
