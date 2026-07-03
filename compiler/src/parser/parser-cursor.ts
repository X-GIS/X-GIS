import { TokenType, type Token } from '../lexer/tokens'

/** Shared token cursor for the recursive-descent parser.
 *
 *  Owns `this.tokens` / `this.pos` and the low-level traversal +
 *  lookahead utilities that both the statement handlers and the
 *  expression precedence ladder share. The `Parser` driver and the
 *  per-concern parsing layers extend this so they all operate on one
 *  cursor (identical `this.pos` advance order). Pure relocation of the
 *  former private utility methods — no behavior change. */
export class ParserCursor {
  protected tokens: Token[]
  protected pos = 0

  constructor(tokens: Token[]) {
    // Filter out newlines for simpler parsing (newlines are not significant in X-GIS)
    this.tokens = tokens.filter((t) => t.type !== TokenType.Newline)
  }

  // ═══ Utility Methods ═══

  protected current(): Token {
    return this.tokens[this.pos] ?? { type: TokenType.EOF, value: '', line: 0, col: 0 }
  }

  protected check(type: TokenType): boolean {
    return this.current().type === type
  }

  protected advance(): Token {
    const token = this.current()
    this.pos++
    return token
  }

  protected expect(type: TokenType): Token {
    const token = this.current()
    if (token.type !== type) {
      this.error(`Expected ${TokenType[type]}, got ${TokenType[token.type]} ('${token.value}')`)
    }
    return this.advance()
  }

  /** Lookahead: is the token after the comma an "identifier:" pattern? */
  protected isNextPropertyStart(): boolean {
    // Current pos is at Comma. Check pos+1 and pos+2.
    const next1 = this.tokens[this.pos + 1]
    const next2 = this.tokens[this.pos + 2]
    return (
      next1 !== undefined &&
      next1.type === TokenType.Identifier &&
      next2 !== undefined &&
      next2.type === TokenType.Colon
    )
  }

  protected isEnd(): boolean {
    return this.current().type === TokenType.EOF
  }

  protected error(msg: string): never {
    const token = this.current()
    throw new Error(`[Parser] ${msg} at line ${token.line}, col ${token.col}`)
  }
}
