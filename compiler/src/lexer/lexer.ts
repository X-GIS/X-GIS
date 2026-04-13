import { TokenType, type Token, lookupKeyword, lookupUnit } from './tokens'

export class Lexer {
  private src: string
  private pos = 0
  private line = 1
  private col = 1
  private tokens: Token[] = []

  constructor(source: string) {
    this.src = source
  }

  tokenize(): Token[] {
    while (this.pos < this.src.length) {
      this.skipWhitespace()
      if (this.pos >= this.src.length) break

      const ch = this.src[this.pos]

      // Newline
      if (ch === '\n') {
        this.push(TokenType.Newline, '\n')
        this.pos++
        this.line++
        this.col = 1
        continue
      }

      // Comments: // and /* */
      if (ch === '/' && this.peek(1) === '/') {
        this.skipLineComment()
        continue
      }
      if (ch === '/' && this.peek(1) === '*') {
        this.skipBlockComment()
        continue
      }

      // String: "..."
      if (ch === '"') {
        this.readString()
        continue
      }

      // Color: #hex
      if (ch === '#') {
        this.readColor()
        continue
      }

      // Number: 0-9
      if (this.isDigit(ch)) {
        this.readNumber()
        continue
      }

      // Identifier / keyword / unit
      if (this.isAlpha(ch) || ch === '_') {
        this.readIdentifier()
        continue
      }

      // Dot / DotDot
      if (ch === '.') {
        if (this.peek(1) === '.') {
          this.push(TokenType.DotDot, '..')
          this.advance(2)
        } else {
          this.push(TokenType.Dot, '.')
          this.advance(1)
        }
        continue
      }

      // 2-char symbols
      if (ch === '=' && this.peek(1) === '=') { this.push(TokenType.EqEq, '=='); this.advance(2); continue }
      if (ch === '!' && this.peek(1) === '=') { this.push(TokenType.BangEq, '!='); this.advance(2); continue }
      if (ch === '<' && this.peek(1) === '=') { this.push(TokenType.LtEq, '<='); this.advance(2); continue }
      if (ch === '>' && this.peek(1) === '=') { this.push(TokenType.GtEq, '>='); this.advance(2); continue }
      if (ch === '&' && this.peek(1) === '&') { this.push(TokenType.AmpAmp, '&&'); this.advance(2); continue }
      if (ch === '|' && this.peek(1) === '|') { this.push(TokenType.PipePipe, '||'); this.advance(2); continue }
      if (ch === '-' && this.peek(1) === '>') { this.push(TokenType.Arrow, '->'); this.advance(2); continue }

      // 1-char symbols
      const singleChars: Record<string, TokenType> = {
        '(': TokenType.LParen, ')': TokenType.RParen,
        '{': TokenType.LBrace, '}': TokenType.RBrace,
        '[': TokenType.LBracket, ']': TokenType.RBracket,
        ':': TokenType.Colon, ',': TokenType.Comma,
        '=': TokenType.Eq, '<': TokenType.Lt, '>': TokenType.Gt,
        '+': TokenType.Plus, '-': TokenType.Minus,
        '*': TokenType.Star, '/': TokenType.Slash, '%': TokenType.Percent,
        '&': TokenType.Amp, '|': TokenType.Pipe, '!': TokenType.Bang, '?': TokenType.Question,
      }

      const tokenType = singleChars[ch]
      if (tokenType !== undefined) {
        this.push(tokenType, ch)
        this.advance(1)
        continue
      }

      this.error(`Unexpected character: '${ch}'`)
    }

    this.push(TokenType.EOF, '')
    return this.tokens
  }

  private readString(): void {
    const startCol = this.col
    this.pos++ // skip opening "
    this.col++

    let value = ''
    while (this.pos < this.src.length && this.src[this.pos] !== '"') {
      if (this.src[this.pos] === '\\') {
        this.pos++
        this.col++
        const esc = this.src[this.pos]
        if (esc === 'n') value += '\n'
        else if (esc === 't') value += '\t'
        else if (esc === '\\') value += '\\'
        else if (esc === '"') value += '"'
        else value += esc
      } else {
        value += this.src[this.pos]
      }
      this.pos++
      this.col++
    }

    if (this.pos >= this.src.length) {
      this.error('Unterminated string')
    }

    this.pos++ // skip closing "
    this.col++
    this.tokens.push({ type: TokenType.String, value, line: this.line, col: startCol })
  }

  private readColor(): void {
    const startCol = this.col
    this.pos++ // skip #
    this.col++

    let value = '#'
    while (this.pos < this.src.length && this.isHexDigit(this.src[this.pos])) {
      value += this.src[this.pos]
      this.pos++
      this.col++
    }

    if (value.length !== 4 && value.length !== 7 && value.length !== 9) {
      this.error(`Invalid color literal: ${value} (expected #RGB, #RRGGBB, or #RRGGBBAA)`)
    }

    this.tokens.push({ type: TokenType.Color, value, line: this.line, col: startCol })
  }

  private readNumber(): void {
    const startCol = this.col
    let value = ''

    while (this.pos < this.src.length && this.isDigit(this.src[this.pos])) {
      value += this.src[this.pos]
      this.pos++
      this.col++
    }

    // Decimal part
    if (this.pos < this.src.length && this.src[this.pos] === '.' && this.isDigit(this.src[this.pos + 1] ?? '')) {
      value += '.'
      this.pos++
      this.col++
      while (this.pos < this.src.length && this.isDigit(this.src[this.pos])) {
        value += this.src[this.pos]
        this.pos++
        this.col++
      }
    }

    this.tokens.push({ type: TokenType.Number, value, line: this.line, col: startCol })

    // Check for unit suffix (px, m, km, etc.)
    if (this.pos < this.src.length && this.isAlpha(this.src[this.pos])) {
      const unitStart = this.pos
      const unitCol = this.col
      let unitStr = ''
      while (this.pos < this.src.length && this.isAlpha(this.src[this.pos])) {
        unitStr += this.src[this.pos]
        this.pos++
        this.col++
      }
      const unitType = lookupUnit(unitStr)
      if (unitType !== null) {
        this.tokens.push({ type: unitType, value: unitStr, line: this.line, col: unitCol })
      } else {
        // Not a unit — put it back, it's a separate identifier
        this.pos = unitStart
        this.col = unitCol
      }
    }
  }

  private readIdentifier(): void {
    const startCol = this.col
    let value = ''

    while (this.pos < this.src.length && (this.isAlphaNumeric(this.src[this.pos]) || this.src[this.pos] === '_')) {
      value += this.src[this.pos]
      this.pos++
      this.col++
    }

    const type = lookupKeyword(value)
    this.tokens.push({ type, value, line: this.line, col: startCol })
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.pos++
        this.col++
      } else {
        break
      }
    }
  }

  private skipLineComment(): void {
    while (this.pos < this.src.length && this.src[this.pos] !== '\n') {
      this.pos++
      this.col++
    }
  }

  private skipBlockComment(): void {
    this.pos += 2 // skip /*
    this.col += 2
    while (this.pos < this.src.length) {
      if (this.src[this.pos] === '*' && this.peek(1) === '/') {
        this.pos += 2 // skip */
        this.col += 2
        return
      }
      if (this.src[this.pos] === '\n') {
        this.line++
        this.col = 1
      } else {
        this.col++
      }
      this.pos++
    }
  }

  private peek(offset: number): string {
    return this.src[this.pos + offset] ?? ''
  }

  private advance(n: number): void {
    this.pos += n
    this.col += n
  }

  private push(type: TokenType, value: string): void {
    this.tokens.push({ type, value, line: this.line, col: this.col })
  }

  private isDigit(ch: string): boolean { return ch >= '0' && ch <= '9' }
  private isAlpha(ch: string): boolean { return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' }
  private isAlphaNumeric(ch: string): boolean { return this.isAlpha(ch) || this.isDigit(ch) }
  private isHexDigit(ch: string): boolean { return this.isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F') }

  private error(msg: string): never {
    throw new Error(`[Lexer] ${msg} at line ${this.line}, col ${this.col}`)
  }
}
