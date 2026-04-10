import { TokenType, type Token } from '../lexer/tokens'
import type * as AST from './ast'

export class Parser {
  private tokens: Token[]
  private pos = 0

  constructor(tokens: Token[]) {
    // Filter out newlines for simpler parsing (newlines are not significant in X-GIS)
    this.tokens = tokens.filter((t) => t.type !== TokenType.Newline)
  }

  parse(): AST.Program {
    const body: AST.Statement[] = []
    while (!this.isEnd()) {
      body.push(this.parseStatement())
    }
    return { kind: 'Program', body }
  }

  private parseStatement(): AST.Statement {
    const token = this.current()

    switch (token.type) {
      case TokenType.Let:
        return this.parseLetStatement()
      case TokenType.Show:
        return this.parseShowStatement()
      case TokenType.Fn:
        return this.parseFnStatement()
      case TokenType.Source:
        return this.parseSourceStatement()
      case TokenType.Layer:
        return this.parseLayerStatement()
      case TokenType.Preset:
        return this.parsePresetStatement()
      default:
        return this.parseExprStatement()
    }
  }

  // let name = expr
  private parseLetStatement(): AST.LetStatement {
    const line = this.current().line
    this.expect(TokenType.Let)
    const name = this.expect(TokenType.Identifier).value
    this.expect(TokenType.Eq)
    const value = this.parseExpr()

    return { kind: 'LetStatement', name, value, line }
  }

  // show target { properties }
  private parseShowStatement(): AST.ShowStatement {
    const line = this.current().line
    this.expect(TokenType.Show)
    const target = this.parseExpr()
    const block = this.parseShowBlock()

    return { kind: 'ShowStatement', target, block, line }
  }

  // { property: value, ... }
  private parseShowBlock(): AST.ShowBlock {
    this.expect(TokenType.LBrace)
    const properties: AST.ShowProperty[] = []

    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      properties.push(this.parseShowProperty())
    }

    this.expect(TokenType.RBrace)
    return { kind: 'ShowBlock', properties }
  }

  // name: value [, value2]
  private parseShowProperty(): AST.ShowProperty {
    const line = this.current().line
    const name = this.expect(TokenType.Identifier).value
    this.expect(TokenType.Colon)

    const values: AST.Expr[] = [this.parseExpr()]

    // Additional comma-separated values (e.g., stroke: #ccc, 1px)
    // But stop if the next token after comma is "identifier:" (next property)
    while (this.check(TokenType.Comma)) {
      // Lookahead: if comma is followed by Identifier + Colon, it's a property separator
      if (this.isNextPropertyStart()) {
        this.advance() // skip comma (property separator)
        break
      }
      this.advance() // skip comma (value separator)
      values.push(this.parseExpr())
    }

    return { kind: 'ShowProperty', name, values, line }
  }

  // fn name(params) -> ReturnType { body }
  private parseFnStatement(): AST.FnStatement {
    const line = this.current().line
    this.expect(TokenType.Fn)
    const name = this.expect(TokenType.Identifier).value

    this.expect(TokenType.LParen)
    const params: AST.Param[] = []
    while (!this.check(TokenType.RParen) && !this.isEnd()) {
      const pName = this.expect(TokenType.Identifier).value
      this.expect(TokenType.Colon)
      const pType = this.expect(TokenType.Identifier).value
      params.push({ name: pName, type: pType })
      if (this.check(TokenType.Comma)) this.advance()
    }
    this.expect(TokenType.RParen)

    let returnType: string | null = null
    if (this.check(TokenType.Arrow)) {
      this.advance()
      returnType = this.expect(TokenType.Identifier).value
    }

    this.expect(TokenType.LBrace)
    const body: AST.Statement[] = []
    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      body.push(this.parseStatement())
    }
    this.expect(TokenType.RBrace)

    return { kind: 'FnStatement', name, params, returnType, body, line }
  }

  // source name { key: value, ... }
  private parseSourceStatement(): AST.SourceStatement {
    const line = this.current().line
    this.expect(TokenType.Source)
    const name = this.expect(TokenType.Identifier).value
    this.expect(TokenType.LBrace)

    const properties: AST.BlockProperty[] = []
    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      properties.push(this.parseBlockProperty())
      // skip optional comma between properties
      if (this.check(TokenType.Comma)) this.advance()
    }
    this.expect(TokenType.RBrace)

    return { kind: 'SourceStatement', name, properties, line }
  }

  // layer name { key: value, ... | utility-items ... }
  private parseLayerStatement(): AST.LayerStatement {
    const line = this.current().line
    this.expect(TokenType.Layer)
    const name = this.expect(TokenType.Identifier).value
    this.expect(TokenType.LBrace)

    const properties: AST.BlockProperty[] = []
    const utilities: AST.UtilityLine[] = []

    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      if (this.check(TokenType.Pipe)) {
        // Utility line: | item item item ...
        utilities.push(this.parseUtilityLine())
      } else {
        // Block property: key: value
        properties.push(this.parseBlockProperty())
        // skip optional comma
        if (this.check(TokenType.Comma)) this.advance()
      }
    }
    this.expect(TokenType.RBrace)

    return { kind: 'LayerStatement', name, properties, utilities, line }
  }

  // preset name { | utility-lines ... }
  private parsePresetStatement(): AST.PresetStatement {
    const line = this.current().line
    this.expect(TokenType.Preset)
    const name = this.expect(TokenType.Identifier).value
    this.expect(TokenType.LBrace)

    const utilities: AST.UtilityLine[] = []
    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      if (this.check(TokenType.Pipe)) {
        utilities.push(this.parseUtilityLine())
      } else {
        this.error(`Expected | in preset block, got ${TokenType[this.current().type]}`)
      }
    }
    this.expect(TokenType.RBrace)

    return { kind: 'PresetStatement', name, utilities, line }
  }

  // key: value (used in source and layer blocks)
  // Uses parseComparison() instead of parseExpr() to avoid consuming | as pipe operator
  private parseBlockProperty(): AST.BlockProperty {
    const line = this.current().line
    const name = this.expectIdentifierOrKeyword()
    this.expect(TokenType.Colon)
    const value = this.parseComparison()
    return { kind: 'BlockProperty', name, value, line }
  }

  // | item item item (until next | or })
  private parseUtilityLine(): AST.UtilityLine {
    const line = this.current().line
    this.expect(TokenType.Pipe)

    const items: AST.UtilityItem[] = []
    // Parse items until we hit another |, }, or EOF
    while (
      !this.check(TokenType.Pipe) &&
      !this.check(TokenType.RBrace) &&
      !this.isEnd()
    ) {
      items.push(this.parseUtilityItem())
    }

    return { kind: 'UtilityLine', items, line }
  }

  // Parse a single utility item like "fill-red-500", "z8:opacity-40", "size-[expr]"
  private parseUtilityItem(): AST.UtilityItem {
    let modifier: string | null = null

    // Check for modifier pattern: identifier:identifier-...
    // e.g., z8:opacity-40, friendly:fill-green-500, hover:glow-8
    if (this.isModifierPattern()) {
      modifier = this.advance().value // consume the modifier identifier
      this.expect(TokenType.Colon)    // consume ':'
    }

    // Parse the utility name: hyphen-joined tokens like "fill-red-500", "stroke-2"
    const name = this.parseUtilityName()

    // Check for data binding: -[expr] or [expr]
    let binding: AST.Expr | null = null
    // Handle size-[speed], fill-[expr] patterns: minus followed by bracket
    if (this.check(TokenType.Minus) && this.tokens[this.pos + 1]?.type === TokenType.LBracket) {
      this.advance() // skip '-'
      this.advance() // skip '['
      binding = this.parseExpr()
      this.expect(TokenType.RBracket)
    } else if (this.check(TokenType.LBracket)) {
      this.advance() // skip [
      binding = this.parseExpr()
      this.expect(TokenType.RBracket)
    }

    return { kind: 'UtilityItem', modifier, name, binding }
  }

  /**
   * Parse a hyphen-joined utility name like "fill-red-500", "stroke-white", "opacity-80".
   * Consumes: Identifier/Number/Color tokens joined by Minus tokens.
   */
  private parseUtilityName(): string {
    let name = ''

    // First token must be an identifier
    if (this.check(TokenType.Identifier)) {
      name = this.advance().value
    } else if (this.check(TokenType.Number)) {
      name = this.advance().value
      return name
    } else {
      this.error(`Expected utility name, got ${TokenType[this.current().type]} ('${this.current().value}')`)
    }

    // Continue consuming -identifier, -number, -color segments
    while (this.check(TokenType.Minus)) {
      // Peek ahead: if next after minus is not part of utility name, stop
      const next = this.tokens[this.pos + 1]
      if (
        !next ||
        (next.type !== TokenType.Identifier &&
         next.type !== TokenType.Number &&
         next.type !== TokenType.Color)
      ) {
        break
      }
      this.advance() // consume '-'
      name += '-' + this.advance().value
    }

    return name
  }

  /**
   * Lookahead: is this a modifier pattern (identifier followed by colon,
   * then another identifier that starts a utility name)?
   * Distinguishes "z8:opacity-40" (modifier) from "source: neighborhoods" (property).
   */
  private isModifierPattern(): boolean {
    if (!this.check(TokenType.Identifier)) return false
    const next1 = this.tokens[this.pos + 1]
    const next2 = this.tokens[this.pos + 2]
    if (!next1 || next1.type !== TokenType.Colon) return false
    // After colon, must be an identifier (utility name start)
    // But we need to distinguish from block properties — block properties
    // are only parsed outside utility lines, so inside utility lines this is always a modifier
    return next2 !== undefined && next2.type === TokenType.Identifier
  }

  /**
   * Consume an identifier token, but also accept keywords used as property names
   * (e.g., "source" in layer block: "source: world").
   */
  private expectIdentifierOrKeyword(): string {
    const token = this.current()
    // Accept identifier and keyword tokens that can be used as property names
    if (
      token.type === TokenType.Identifier ||
      token.type === TokenType.Source ||
      token.type === TokenType.Layer ||
      token.type === TokenType.View ||
      token.type === TokenType.On
    ) {
      this.advance()
      return token.value
    }
    return this.expect(TokenType.Identifier).value
  }

  private parseExprStatement(): AST.ExprStatement {
    const line = this.current().line
    const expr = this.parseExpr()
    return { kind: 'ExprStatement', expr, line }
  }

  // ═══ Expression Parsing (Pratt / Precedence Climbing) ═══

  private parseExpr(): AST.Expr {
    return this.parsePipe()
  }

  // expr | transform | transform
  private parsePipe(): AST.Expr {
    let left = this.parseLogicalOr()

    if (this.check(TokenType.Pipe)) {
      const transforms: AST.FnCall[] = []
      while (this.check(TokenType.Pipe)) {
        this.advance() // skip |
        const callee = this.parsePrimary()
        let args: AST.Expr[] = []
        if (this.check(TokenType.LParen)) {
          args = this.parseArgList()
        }
        transforms.push({ kind: 'FnCall', callee, args })
      }
      return { kind: 'PipeExpr', input: left, transforms }
    }

    return left
  }

  // ||
  private parseLogicalOr(): AST.Expr {
    let left = this.parseLogicalAnd()
    while (this.check(TokenType.PipePipe)) {
      const op = this.advance().value
      const right = this.parseLogicalAnd()
      left = { kind: 'BinaryExpr', op, left, right }
    }
    return left
  }

  // &&
  private parseLogicalAnd(): AST.Expr {
    let left = this.parseComparison()
    while (this.check(TokenType.AmpAmp)) {
      const op = this.advance().value
      const right = this.parseComparison()
      left = { kind: 'BinaryExpr', op, left, right }
    }
    return left
  }

  // ==, !=, <, >, <=, >=
  private parseComparison(): AST.Expr {
    let left = this.parseAdditive()

    while (
      this.check(TokenType.EqEq) || this.check(TokenType.BangEq) ||
      this.check(TokenType.Lt) || this.check(TokenType.Gt) ||
      this.check(TokenType.LtEq) || this.check(TokenType.GtEq)
    ) {
      const op = this.advance().value
      const right = this.parseAdditive()
      left = { kind: 'BinaryExpr', op, left, right }
    }

    return left
  }

  // +, -
  private parseAdditive(): AST.Expr {
    let left = this.parseMultiplicative()

    while (this.check(TokenType.Plus) || this.check(TokenType.Minus)) {
      const op = this.advance().value
      const right = this.parseMultiplicative()
      left = { kind: 'BinaryExpr', op, left, right }
    }

    return left
  }

  // *, /, %
  private parseMultiplicative(): AST.Expr {
    let left = this.parseUnary()

    while (this.check(TokenType.Star) || this.check(TokenType.Slash) || this.check(TokenType.Percent)) {
      const op = this.advance().value
      const right = this.parseUnary()
      left = { kind: 'BinaryExpr', op, left, right }
    }

    return left
  }

  // -, !
  private parseUnary(): AST.Expr {
    if (this.check(TokenType.Minus) || this.check(TokenType.Bang)) {
      const op = this.advance().value
      const operand = this.parseUnary()
      return { kind: 'UnaryExpr', op, operand }
    }
    return this.parsePostfix()
  }

  // function calls, field access
  private parsePostfix(): AST.Expr {
    let expr = this.parsePrimary()

    while (true) {
      if (this.check(TokenType.LParen)) {
        const args = this.parseArgList()
        expr = { kind: 'FnCall', callee: expr, args }
      } else if (this.check(TokenType.Dot)) {
        this.advance()
        const field = this.expect(TokenType.Identifier).value
        expr = { kind: 'FieldAccess', object: expr, field }
      } else {
        break
      }
    }

    return expr
  }

  private parsePrimary(): AST.Expr {
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
        this.check(TokenType.Px) || this.check(TokenType.M) ||
        this.check(TokenType.Km) || this.check(TokenType.Nm) ||
        this.check(TokenType.Deg) || this.check(TokenType.S) ||
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

    // Grouped expression: ( expr )
    if (token.type === TokenType.LParen) {
      this.advance()
      const expr = this.parseExpr()
      this.expect(TokenType.RParen)
      return expr
    }

    this.error(`Unexpected token: ${token.value} (${TokenType[token.type]})`)
  }

  private parseArgList(): AST.Expr[] {
    this.expect(TokenType.LParen)
    const args: AST.Expr[] = []

    while (!this.check(TokenType.RParen) && !this.isEnd()) {
      args.push(this.parseExpr())
      if (this.check(TokenType.Comma)) this.advance()
    }

    this.expect(TokenType.RParen)
    return args
  }

  // ═══ Utility Methods ═══

  private current(): Token {
    return this.tokens[this.pos] ?? { type: TokenType.EOF, value: '', line: 0, col: 0 }
  }

  private check(type: TokenType): boolean {
    return this.current().type === type
  }

  private advance(): Token {
    const token = this.current()
    this.pos++
    return token
  }

  private expect(type: TokenType): Token {
    const token = this.current()
    if (token.type !== type) {
      this.error(`Expected ${TokenType[type]}, got ${TokenType[token.type]} ('${token.value}')`)
    }
    return this.advance()
  }

  /** Lookahead: is the token after the comma an "identifier:" pattern? */
  private isNextPropertyStart(): boolean {
    // Current pos is at Comma. Check pos+1 and pos+2.
    const next1 = this.tokens[this.pos + 1]
    const next2 = this.tokens[this.pos + 2]
    return (
      next1 !== undefined && next1.type === TokenType.Identifier &&
      next2 !== undefined && next2.type === TokenType.Colon
    )
  }

  private isEnd(): boolean {
    return this.current().type === TokenType.EOF
  }

  private error(msg: string): never {
    const token = this.current()
    throw new Error(`[Parser] ${msg} at line ${token.line}, col ${token.col}`)
  }
}
