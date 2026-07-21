import { TokenType } from '../lexer/tokens'
import type * as AST from './ast'
import { ParserCursor } from './parser-cursor'

/** Expression precedence ladder (Pratt / precedence climbing).
 *
 *  Relocated verbatim from the former monolithic Parser. Extends the
 *  shared cursor so the statement layer (which extends this in turn)
 *  and the expression entry points all advance the same `this.pos`.
 *  Also hosts `parseMatchBlock` (consumed by both the postfix `match`
 *  block and the utility-item / match-arm statement productions) and
 *  `parseArgList`. No behavior change — same call/iteration order. */
export class ExpressionParser extends ParserCursor {
  // ═══ Expression Parsing (Pratt / Precedence Climbing) ═══

  // The expression-level pipe operator (`x | round | clamp(0, 10)`) was
  // removed (#1238): it was pure sugar over nested calls and its `|`
  // token collided with the utility-line `|`, silently swallowing a new
  // utility block after any bare expression-valued utility (#1236). The
  // `|` token now belongs to utility lines alone.
  protected parseExpr(): AST.Expr {
    const expr = this.parseCoalesce()
    // Ternary: expr ? thenExpr : elseExpr
    if (this.check(TokenType.Question)) {
      this.advance()
      const thenExpr = this.parseExpr()
      this.expect(TokenType.Colon)
      const elseExpr = this.parseExpr()
      return { kind: 'ConditionalExpr', condition: expr, thenExpr, elseExpr }
    }
    return expr
  }

  // ?? — null/undefined/missing fallback. Sits between ternary
  // and `||` in precedence so `.height ?? 50` parses as a single
  // BinaryExpr without paren juggling, and `a || b ?? c` parses
  // as `(a || b) ?? c` (the `||` binds tighter, like JS where the
  // two cannot mix without parens but this engine resolves with a
  // flat lower-precedence rule). Right-associative chaining via
  // the while-loop below: `.h ?? .level * 3 ?? 50` walks
  // left→right, binding the rightmost first thanks to the chain.
  protected parseCoalesce(): AST.Expr {
    let left = this.parseLogicalOr()
    while (this.check(TokenType.QuestionQuestion)) {
      const op = this.advance().value
      const right = this.parseLogicalOr()
      left = { kind: 'BinaryExpr', op, left, right }
    }
    return left
  }

  // ||
  protected parseLogicalOr(): AST.Expr {
    let left = this.parseLogicalAnd()
    while (this.check(TokenType.PipePipe)) {
      const op = this.advance().value
      const right = this.parseLogicalAnd()
      left = { kind: 'BinaryExpr', op, left, right }
    }
    return left
  }

  // &&
  protected parseLogicalAnd(): AST.Expr {
    let left = this.parseComparison()
    while (this.check(TokenType.AmpAmp)) {
      const op = this.advance().value
      const right = this.parseComparison()
      left = { kind: 'BinaryExpr', op, left, right }
    }
    return left
  }

  // ==, !=, <, >, <=, >=
  protected parseComparison(): AST.Expr {
    let left = this.parseAdditive()

    while (
      this.check(TokenType.EqEq) ||
      this.check(TokenType.BangEq) ||
      this.check(TokenType.Lt) ||
      this.check(TokenType.Gt) ||
      this.check(TokenType.LtEq) ||
      this.check(TokenType.GtEq)
    ) {
      const op = this.advance().value
      const right = this.parseAdditive()
      left = { kind: 'BinaryExpr', op, left, right }
    }

    return left
  }

  // +, -
  protected parseAdditive(): AST.Expr {
    let left = this.parseMultiplicative()

    while (this.check(TokenType.Plus) || this.check(TokenType.Minus)) {
      const op = this.advance().value
      const right = this.parseMultiplicative()
      left = { kind: 'BinaryExpr', op, left, right }
    }

    return left
  }

  // *, /, %
  protected parseMultiplicative(): AST.Expr {
    let left = this.parseUnary()

    while (
      this.check(TokenType.Star) ||
      this.check(TokenType.Slash) ||
      this.check(TokenType.Percent)
    ) {
      const op = this.advance().value
      const right = this.parseUnary()
      left = { kind: 'BinaryExpr', op, left, right }
    }

    return left
  }

  // -, !
  protected parseUnary(): AST.Expr {
    if (this.check(TokenType.Minus) || this.check(TokenType.Bang)) {
      const op = this.advance().value
      const operand = this.parseUnary()
      return { kind: 'UnaryExpr', op, operand }
    }
    return this.parsePostfix()
  }

  // function calls, field access
  protected parsePostfix(): AST.Expr {
    let expr = this.parsePrimary()

    while (true) {
      if (this.check(TokenType.LParen)) {
        const args = this.parseArgList()
        const call: AST.FnCall = { kind: 'FnCall', callee: expr, args }
        // `match(field) { "k" -> v, _ -> default }` — the trailing
        // block is part of the match expression. Originally only
        // recognized inside utility-item position (parseUtilityItem),
        // but a value-mapping match makes sense in any expression
        // context (filter:, paint utility brackets, ternaries…), so
        // pick up the block uniformly here.
        if (
          call.callee.kind === 'Identifier' &&
          call.callee.name === 'match' &&
          this.check(TokenType.LBrace)
        ) {
          call.matchBlock = this.parseMatchBlock()
        }
        expr = call
      } else if (this.check(TokenType.Dot)) {
        this.advance()
        const field = this.expect(TokenType.Identifier).value
        expr = { kind: 'FieldAccess', object: expr, field }
      } else if (this.check(TokenType.LBracket)) {
        this.advance()
        const index = this.parseExpr()
        this.expect(TokenType.RBracket)
        expr = { kind: 'ArrayAccess', array: expr, index }
      } else {
        break
      }
    }

    return expr
  }

  protected parsePrimary(): AST.Expr {
    const token = this.current()

    // .field (implicit data binding)
    if (token.type === TokenType.Dot) {
      this.advance()
      const field = this.expect(TokenType.Identifier).value
      return { kind: 'FieldAccess', object: null, field }
    }

    // Number (with optional unit)
    if (token.type === TokenType.Number) {
      this.advance()
      const value = parseFloat(token.value)
      let unit: string | null = null

      // Check for unit token immediately after
      if (
        this.check(TokenType.Px) ||
        this.check(TokenType.M) ||
        this.check(TokenType.Km) ||
        this.check(TokenType.Nm) ||
        this.check(TokenType.Deg) ||
        this.check(TokenType.S) ||
        this.check(TokenType.Ms)
      ) {
        unit = this.advance().value
      }

      return { kind: 'NumberLiteral', value, unit }
    }

    // String
    if (token.type === TokenType.String) {
      this.advance()
      return { kind: 'StringLiteral', value: token.value }
    }

    // Color
    if (token.type === TokenType.Color) {
      this.advance()
      return { kind: 'ColorLiteral', value: token.value }
    }

    // Bool
    if (token.type === TokenType.Bool) {
      this.advance()
      return { kind: 'BoolLiteral', value: token.value === 'true' }
    }

    // Identifier
    if (token.type === TokenType.Identifier) {
      this.advance()
      // Check for match block: identifier { key: value, ... }
      // (used in show properties like: .type { hostile: #ff0000, _: #808080 })
      return { kind: 'Identifier', name: token.value }
    }

    // Array literal: [expr, expr, ...]
    if (token.type === TokenType.LBracket) {
      this.advance()
      const elements: AST.Expr[] = []
      while (!this.check(TokenType.RBracket) && !this.check(TokenType.EOF)) {
        elements.push(this.parseExpr())
        if (this.check(TokenType.Comma)) this.advance()
      }
      this.expect(TokenType.RBracket)
      return { kind: 'ArrayLiteral', elements }
    }

    // Object literal: { "key": expr, key: expr, ... }
    // Value-position only — a bare `{` here is unambiguous (match blocks
    // are identifier-prefixed and parsed in parsePostfix / parseMatchBlock,
    // never at the start of a primary). Used by `source x { data: {...} }`
    // to embed inline GeoJSON. Keys may be a string- or identifier-literal.
    if (token.type === TokenType.LBrace) {
      this.advance()
      const properties: { key: string; value: AST.Expr }[] = []
      while (!this.check(TokenType.RBrace) && !this.check(TokenType.EOF)) {
        let key: string
        if (this.check(TokenType.String)) {
          key = this.advance().value
        } else if (this.check(TokenType.Identifier)) {
          key = this.advance().value
        } else {
          this.error(
            `Expected object key (string or identifier), got ${TokenType[this.current().type]} ('${this.current().value}')`,
          )
        }
        this.expect(TokenType.Colon)
        const value = this.parseExpr()
        properties.push({ key, value })
        if (this.check(TokenType.Comma)) this.advance()
      }
      this.expect(TokenType.RBrace)
      return { kind: 'ObjectLiteral', properties }
    }

    // Grouped expression: ( expr )
    if (token.type === TokenType.LParen) {
      this.advance()
      const expr = this.parseExpr()
      this.expect(TokenType.RParen)
      return expr
    }

    this.error(`Unexpected token: ${token.value} (${TokenType[token.type]})`)
  }

  protected parseArgList(): AST.Expr[] {
    this.expect(TokenType.LParen)
    const args: AST.Expr[] = []

    while (!this.check(TokenType.RParen) && !this.isEnd()) {
      args.push(this.parseExpr())
      if (this.check(TokenType.Comma)) this.advance()
    }

    this.expect(TokenType.RParen)
    return args
  }

  /**
   * Parse match block: { "KOR" -> #dc2626, 1, 2 -> "low", _ -> #9ca3af }
   *
   * A single arm is `pattern (',' pattern)* '->' value`. Comma-separated
   * pattern LISTS desugar into one {@link AST.MatchArm} per label sharing the
   * arm's value — semantically identical to writing the label out N times, and
   * every downstream consumer already handles repeated single-label arms (this
   * is exactly the shape the Mapbox converter emits for `["a","b"]` labels).
   * The arrow is a hard boundary, so a comma BEFORE it always continues the
   * pattern list and a comma AFTER the value always separates arms — the two
   * comma roles never collide (#1068).
   */
  protected parseMatchBlock(): AST.MatchBlock {
    this.expect(TokenType.LBrace)
    const arms: AST.MatchArm[] = []

    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      const first = this.parseMatchPattern()
      if (first === null) break // not on a label token — end of the arm list
      const patterns: (string | number)[] = [first]
      while (this.check(TokenType.Comma)) {
        this.advance() // consume the pattern-list comma
        const next = this.parseMatchPattern()
        if (next === null) break // tolerate a stray trailing comma before `->`
        patterns.push(next)
      }

      // Arrow: ->
      this.expect(TokenType.Arrow)

      // Value shapes: #abcdef → ColorLiteral; else a general expression via
      // parseExpr. A bare hyphenated Identifier is NO LONGER special-cased as a
      // utility colour name — that swallowed `foo - 1` into an `foo-1` colour
      // token and made arithmetic in an arm value unwritable. Use a colour
      // literal (`#…`) or a bracketed expression as the escape instead (#1068).
      let value: AST.Expr
      if (this.check(TokenType.Color)) {
        value = { kind: 'ColorLiteral', value: this.advance().value }
      } else {
        value = this.parseExpr()
      }

      // Desugar the pattern list: one arm per label, sharing the value AST.
      for (const pattern of patterns) arms.push({ pattern, value })

      // Optional comma/newline separator between arms
      if (this.check(TokenType.Comma)) this.advance()
    }

    this.expect(TokenType.RBrace)
    return { kind: 'MatchBlock', arms }
  }

  /** Parse one match label: a string / identifier (`_` = default), a bare
   *  number, or a `Minus`-prefixed negative number (the converter emits bare
   *  numeric keys, e.g. `-3 -> v`). Numbers keep their JS `number` type so the
   *  evaluator compares them numerically. Returns null when the cursor is not
   *  on a label token (i.e. the arm list has ended). */
  protected parseMatchPattern(): string | number | null {
    if (this.check(TokenType.String)) return this.advance().value
    if (this.check(TokenType.Identifier)) return this.advance().value
    if (this.check(TokenType.Number)) return Number(this.advance().value)
    if (this.check(TokenType.Minus) && this.tokens[this.pos + 1]?.type === TokenType.Number) {
      this.advance()
      return -Number(this.advance().value)
    }
    return null
  }

  /**
   * Parse a hyphen-joined utility name like "fill-red-500", "stroke-white", "opacity-80".
   * Consumes: Identifier/Number/Color tokens joined by Minus tokens.
   */
  /** Check if token can start or continue a utility name (identifiers + keywords used as names) */
  protected isUtilityNameToken(): boolean {
    const t = this.current().type
    return (
      t === TokenType.Identifier ||
      t === TokenType.SymbolDef ||
      t === TokenType.Source ||
      t === TokenType.Layer ||
      t === TokenType.Preset ||
      // Short keywords that naturally appear inside utility names, e.g.
      // `from-red-500`, `to-blue-500`. Without these, `from` / `to`
      // would short-circuit the hyphen-joined name accumulator and
      // break utility parsing. (`in` lexes as a plain identifier.)
      t === TokenType.From ||
      t === TokenType.To
    )
  }

  protected parseUtilityName(): string {
    let name = ''

    // First token must be an identifier or keyword used as utility name
    if (this.isUtilityNameToken()) {
      name = this.advance().value
    } else if (this.check(TokenType.Number)) {
      name = this.advance().value
      return name
    } else {
      this.error(
        `Expected utility name, got ${TokenType[this.current().type]} ('${this.current().value}')`,
      )
    }

    // Continue consuming -identifier, -number, -color segments
    while (this.check(TokenType.Minus)) {
      // Peek ahead: if next after minus is not part of utility name, stop
      const next = this.tokens[this.pos + 1]
      if (!next) break
      const isNamePart =
        next.type === TokenType.Identifier ||
        next.type === TokenType.Number ||
        next.type === TokenType.Color ||
        next.type === TokenType.SymbolDef ||
        next.type === TokenType.Source ||
        next.type === TokenType.Layer ||
        // Short keywords that appear mid-name: from-red-500,
        // to-blue-500, etc. (`in` lexes as a plain identifier.)
        next.type === TokenType.From ||
        next.type === TokenType.To ||
        // Bool keywords as utility-name suffix: label-keep-upright-true,
        // label-keep-upright-false, label-allow-overlap-true, etc.
        // Mapbox spec uses boolean knobs heavily; emitting them in the
        // hyphen-joined utility form keeps the converter simple.
        next.type === TokenType.Bool
      if (!isNamePart) break
      this.advance() // consume '-'
      name += '-' + this.advance().value
    }

    // Absorb trailing unit token (px, m, km, etc.) into name
    // e.g., size-500 + km → "size-500km"
    if (
      this.check(TokenType.Px) ||
      this.check(TokenType.M) ||
      this.check(TokenType.Km) ||
      this.check(TokenType.Nm) ||
      this.check(TokenType.Deg)
    ) {
      name += this.advance().value
    }

    return name
  }
}
