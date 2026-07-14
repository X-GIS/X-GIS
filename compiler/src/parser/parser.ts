import { TokenType, type Token } from '../lexer/tokens'
import { Lexer } from '../lexer/lexer'
import type * as AST from './ast'
import { StatementParser, STATEMENT_START_TOKENS } from './parser-statements'
import { XGIS_LANGUAGE_MAJOR } from '../language-version'
import { DiagnosticCollector, ParseError, type Diagnostic } from '../diagnostics/diagnostic'

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
    this.consumeVersionPragma()
    const body: AST.Statement[] = []
    while (!this.isEnd()) {
      body.push(this.parseStatement())
    }
    return { kind: 'Program', body }
  }

  /** Parse in RECOVERING mode: instead of throwing on the first syntax
   *  error, record a {@link Diagnostic} and SYNCHRONIZE at the next block
   *  boundary / top-level keyword, so ONE pass reports EVERY error in the
   *  file (the substrate for the LSP + playground error UX, #1065).
   *
   *  The version pragma gate (#1064) stays HARD: `consumeVersionPragma`
   *  runs OUTSIDE the recovery loop, so a missing / newer-major pragma
   *  still throws (X-GIS0008/0009) and recovery never resumes past it — a
   *  wrong-version file must not half-parse. Every other syntax error is
   *  collected; a non-ParseError throw (an internal bug) still propagates.
   *
   *  The default `parse()` (throw-on-first) is UNCHANGED and stays the
   *  entry point for the runtime, module resolver, and existing tests —
   *  its thrown ParseError carries the FIRST structured diagnostic. */
  parseCollect(): { program: AST.Program; diagnostics: Diagnostic[] } {
    this.consumeVersionPragma()
    const collector = new DiagnosticCollector()
    const body: AST.Statement[] = []
    while (!this.isEnd()) {
      try {
        body.push(this.parseStatement())
      } catch (e) {
        if (!(e instanceof ParseError)) throw e
        collector.add(e.diagnostic)
        this.synchronize()
      }
    }
    return { program: { kind: 'Program', body }, diagnostics: collector.all }
  }

  /** Error-recovery synchronization: after a syntax error, skip tokens
   *  until the parser sits at a clean resume point — just PAST a closing
   *  brace (a block boundary) or AT a top-level statement keyword — so the
   *  next `parseStatement()` starts fresh instead of cascading. Always
   *  advances at least one token, so recovery cannot loop forever. */
  private synchronize(): void {
    if (!this.isEnd()) this.advance() // consume the offending token — guarantees progress
    while (!this.isEnd()) {
      // A closing brace ended a block; the next statement begins after it.
      if (this.tokens[this.pos - 1]?.type === TokenType.RBrace) return
      // A top-level statement keyword is a clean resume point.
      if (STATEMENT_START_TOKENS.has(this.current().type)) return
      this.advance()
    }
  }

  /** Consume the mandatory `xgis <major>` version pragma — the gate for
   *  every future language breaking change (#1064). Comments and blank
   *  lines before it are already stripped by the lexer, so the pragma
   *  need only be the first *token*: no statement may precede it.
   *
   *  Hard-errors (the parser's throw shape, with a code from the
   *  X-GIS<NNNN> diagnostics registry embedded in the message):
   *    - X-GIS0008 — the pragma is missing or malformed (no `xgis`
   *      keyword, or no bare-integer major after it);
   *    - X-GIS0009 — the file declares a MAJOR newer than this compiler
   *      implements (`xgis 2` today) — refuse rather than mis-parse.
   *  The version is validated and consumed; nothing downstream reads it
   *  yet, so it is not stored on the AST (a v2 introduces that with its
   *  own semantics). */
  private consumeVersionPragma(): void {
    const head = this.current()
    if (head.type !== TokenType.Identifier || head.value !== 'xgis') {
      this.error(
        `X-GIS0008: missing version pragma — add \`xgis ${XGIS_LANGUAGE_MAJOR}\` ` +
          `as the first statement (comments may precede it)`,
        'X-GIS0008',
      )
    }
    this.advance() // consume `xgis`
    const ver = this.current()
    // MAJOR-ONLY: a bare integer literal. `1.0` / `1px` lex as a decimal /
    // unit-tagged number, so require the raw token to be all digits.
    if (ver.type !== TokenType.Number || !/^\d+$/.test(ver.value)) {
      this.error(
        `X-GIS0008: version pragma needs a bare major-version integer, ` +
          `e.g. \`xgis ${XGIS_LANGUAGE_MAJOR}\``,
        'X-GIS0008',
      )
    }
    const major = parseInt(ver.value, 10)
    if (major > XGIS_LANGUAGE_MAJOR) {
      this.error(
        `X-GIS0009: this file declares \`xgis ${major}\` — it was written ` +
          `for a newer X-GIS. This compiler implements major ` +
          `${XGIS_LANGUAGE_MAJOR}; upgrade @xgis/compiler`,
        'X-GIS0009',
      )
    }
    if (major < 1) {
      this.error(`X-GIS0008: version pragma major must be >= 1, got \`xgis ${major}\``, 'X-GIS0008')
    }
    this.advance() // consume the major-version number
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
