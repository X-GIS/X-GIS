import { TokenType, type Token } from '../lexer/tokens'
import { ParseError, PARSER_SYNTAX_ERROR } from '../diagnostics/diagnostic'

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

  protected isEnd(): boolean {
    return this.current().type === TokenType.EOF
  }

  /** Raise a structured parse error. Throws a {@link ParseError} — a
   *  plain `Error` (message shape UNCHANGED: `[Parser] … at line L, col
   *  C`, so every string-pinning caller keeps working) that additionally
   *  carries a spanned {@link Diagnostic}. `code` defaults to the generic
   *  parser-syntax code; the pragma gate (#1064) passes X-GIS0008/0009.
   *  The recovering `parseCollect` mode catches this to synchronize; the
   *  default throwing `parse` lets it propagate (carrying the FIRST
   *  structured diagnostic). */
  protected error(msg: string, code: string = PARSER_SYNTAX_ERROR): never {
    const token = this.current()
    const message = `[Parser] ${msg} at line ${token.line}, col ${token.col}`
    throw new ParseError(
      { code, severity: 'error', span: { line: token.line, col: token.col }, message: msg },
      message,
    )
  }
}
