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
      case TokenType.Background:
        return this.parseBackgroundStatement()
      case TokenType.Preset:
        return this.parsePresetStatement()
      case TokenType.Import:
        return this.parseImportStatement()
      case TokenType.SymbolDef:
        return this.parseSymbolStatement()
      case TokenType.Style:
        return this.parseStyleStatement()
      case TokenType.Keyframes:
        return this.parseKeyframesStatement()
      case TokenType.If:
        return this.parseIfStatement()
      case TokenType.Return:
        return this.parseReturnStatement()
      case TokenType.For:
        return this.parseForStatement()
      default:
        return this.parseExprStatement()
    }
  }

  // if expr { stmts } else { stmts }
  private parseIfStatement(): AST.IfStatement {
    const line = this.current().line
    this.expect(TokenType.If)
    const condition = this.parseExpr()
    this.expect(TokenType.LBrace)
    const thenBranch: AST.Statement[] = []
    while (!this.check(TokenType.RBrace) && !this.check(TokenType.EOF)) {
      thenBranch.push(this.parseStatement())
    }
    this.expect(TokenType.RBrace)

    let elseBranch: AST.Statement[] | null = null
    if (this.check(TokenType.Else)) {
      this.advance()
      if (this.check(TokenType.If)) {
        // else if — chain as single statement in else branch
        elseBranch = [this.parseIfStatement()]
      } else {
        this.expect(TokenType.LBrace)
        elseBranch = []
        while (!this.check(TokenType.RBrace) && !this.check(TokenType.EOF)) {
          elseBranch.push(this.parseStatement())
        }
        this.expect(TokenType.RBrace)
      }
    }
    return { kind: 'IfStatement', condition, thenBranch, elseBranch, line }
  }

  // return expr
  private parseReturnStatement(): AST.ReturnStatement {
    const line = this.current().line
    this.expect(TokenType.Return)
    let value: AST.Expr | null = null
    if (!this.check(TokenType.RBrace) && !this.check(TokenType.EOF)) {
      value = this.parseExpr()
    }
    return { kind: 'ReturnStatement', value, line }
  }

  // for name in start..end { body }
  private parseForStatement(): AST.ForStatement {
    const line = this.current().line
    this.expect(TokenType.For)
    const variable = this.expect(TokenType.Identifier).value
    this.expect(TokenType.In)
    const start = this.parseExpr()
    this.expect(TokenType.DotDot)
    const end = this.parseExpr()
    this.expect(TokenType.LBrace)
    const body: AST.Statement[] = []
    while (!this.check(TokenType.RBrace) && !this.check(TokenType.EOF)) {
      body.push(this.parseStatement())
    }
    this.expect(TokenType.RBrace)
    return { kind: 'ForStatement', variable, start, end, body, line }
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

  // layer name { key: value, ... | utility-items ... fill: color ... }
  private parseLayerStatement(): AST.LayerStatement {
    const line = this.current().line
    this.expect(TokenType.Layer)
    const name = this.expect(TokenType.Identifier).value
    this.expect(TokenType.LBrace)

    const properties: AST.BlockProperty[] = []
    const utilities: AST.UtilityLine[] = []
    const styleProperties: AST.StyleProperty[] = []

    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      if (this.check(TokenType.Pipe)) {
        // Utility line: | item item item ...
        utilities.push(this.parseUtilityLine())
      } else if (this.isStylePropertyStart()) {
        // CSS-like style property: fill: stone-800, stroke-width: 1
        styleProperties.push(this.parseStyleProperty())
        if (this.check(TokenType.Comma)) this.advance()
      } else {
        // Block property: key: value (source, z-order, style, etc.)
        properties.push(this.parseBlockProperty())
        // skip optional comma
        if (this.check(TokenType.Comma)) this.advance()
      }
    }
    this.expect(TokenType.RBrace)

    return { kind: 'LayerStatement', name, properties, utilities, styleProperties, line }
  }

  // background { fill: sky-900 } — Mapbox-style canvas clear color.
  // Same body grammar as layer (utility lines OR style properties),
  // but no name + no source. Only the resolved fill is consumed by
  // the renderer; everything else is parsed-and-ignored so the same
  // utility ergonomics work (`background { | fill-sky-900 }`).
  private parseBackgroundStatement(): AST.BackgroundStatement {
    const line = this.current().line
    this.expect(TokenType.Background)
    this.expect(TokenType.LBrace)

    const utilities: AST.UtilityLine[] = []
    const styleProperties: AST.StyleProperty[] = []
    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      if (this.check(TokenType.Pipe)) {
        utilities.push(this.parseUtilityLine())
      } else if (this.isStylePropertyStart()) {
        styleProperties.push(this.parseStyleProperty())
        if (this.check(TokenType.Comma)) this.advance()
      } else {
        // Tolerate stray block properties (e.g. someone writes
        // `color: ...`) — skip without erroring; renderer only
        // looks at fill anyway.
        this.parseBlockProperty()
        if (this.check(TokenType.Comma)) this.advance()
      }
    }
    this.expect(TokenType.RBrace)
    return { kind: 'BackgroundStatement', utilities, styleProperties, line }
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

  // import { name1, name2 } from "path"
  private parseImportStatement(): AST.ImportStatement {
    const line = this.current().line
    this.expect(TokenType.Import)
    this.expect(TokenType.LBrace)

    const names: string[] = []
    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      names.push(this.expect(TokenType.Identifier).value)
      if (this.check(TokenType.Comma)) this.advance()
    }
    this.expect(TokenType.RBrace)
    this.expect(TokenType.From)

    const path = this.expect(TokenType.String).value
    return { kind: 'ImportStatement', names, path, line }
  }

  // symbol name { path "...", rect x: N y: N w: N h: N, circle cx: N cy: N r: N, anchor: value }
  private parseSymbolStatement(): AST.SymbolStatement {
    const line = this.current().line
    this.expect(TokenType.SymbolDef)
    const name = this.expect(TokenType.Identifier).value
    this.expect(TokenType.LBrace)

    const elements: AST.SymbolElement[] = []

    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      const keyword = this.current()

      if (keyword.type === TokenType.Identifier && keyword.value === 'path') {
        this.advance()
        const data = this.expect(TokenType.String).value
        elements.push({ kind: 'path', data })
      } else if (keyword.type === TokenType.Identifier && keyword.value === 'rect') {
        this.advance()
        const props = this.parseNumericProps()
        elements.push({ kind: 'rect', props })
      } else if (keyword.type === TokenType.Identifier && keyword.value === 'circle') {
        this.advance()
        const props = this.parseNumericProps()
        elements.push({ kind: 'circle', props })
      } else if (keyword.type === TokenType.Identifier && keyword.value === 'anchor') {
        this.advance()
        this.expect(TokenType.Colon)
        const value = this.expect(TokenType.Identifier).value
        elements.push({ kind: 'anchor', value })
      } else {
        this.error(`Unexpected token in symbol block: ${keyword.value}`)
      }
    }

    this.expect(TokenType.RBrace)
    return { kind: 'SymbolStatement', name, elements, line }
  }

  // style name { fill: stone-800, stroke: slate-600, stroke-width: 1 }
  private parseStyleStatement(): AST.StyleStatement {
    const line = this.current().line
    this.expect(TokenType.Style)
    const name = this.expect(TokenType.Identifier).value
    this.expect(TokenType.LBrace)

    const properties: AST.StyleProperty[] = []
    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      properties.push(this.parseStyleProperty())
      if (this.check(TokenType.Comma)) this.advance()
    }
    this.expect(TokenType.RBrace)

    return { kind: 'StyleStatement', name, properties, line }
  }

  // keyframes pulse { 0%: opacity-100  50%: opacity-30  100%: opacity-100 }
  //
  // Each keyframe: <percent>%: utility utility ...   or   from: ... / to: ...
  // Utilities inside a keyframe must NOT carry modifiers (z8:, hover:, etc.) —
  // a keyframe already IS a point in time, so any modifier would be ambiguous.
  private parseKeyframesStatement(): AST.KeyframesStatement {
    const line = this.current().line
    this.expect(TokenType.Keyframes)
    const name = this.expect(TokenType.Identifier).value
    this.expect(TokenType.LBrace)

    const frames: AST.Keyframe[] = []
    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      frames.push(this.parseKeyframe())
      // separator is implicit (whitespace / newline), commas tolerated
      if (this.check(TokenType.Comma)) this.advance()
    }
    this.expect(TokenType.RBrace)

    // Sort by percent so downstream lowering sees a monotonic sequence.
    frames.sort((a, b) => a.percent - b.percent)
    return { kind: 'KeyframesStatement', name, frames, line }
  }

  // Single keyframe row: `<percent>%: <utilities>` or `from: ...` / `to: ...`
  private parseKeyframe(): AST.Keyframe {
    const line = this.current().line

    // Parse the percent specifier. Accept:
    //   - <number>%  — standard percentage
    //   - from       — alias for 0%
    //   - to         — alias for 100%
    let percent: number
    if (this.check(TokenType.Number)) {
      const n = parseFloat(this.advance().value)
      // The '%' symbol lexes as TokenType.Percent
      if (this.check(TokenType.Percent)) this.advance()
      percent = n
    } else if (this.check(TokenType.From)) {
      this.advance()
      percent = 0
    } else if (this.check(TokenType.To)) {
      this.advance()
      percent = 100
    } else {
      this.error(`Expected percent, 'from', or 'to' in keyframe, got ${TokenType[this.current().type]}`)
    }
    if (percent < 0 || percent > 100) {
      this.error(`Keyframe percent must be in 0..100, got ${percent}`)
    }

    this.expect(TokenType.Colon)

    // Parse utility items until end-of-frame. End conditions: we see another
    // percent specifier (<number>%, from, to) or the closing brace.
    const utilities: AST.UtilityItem[] = []
    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      if (this.isKeyframeBoundary()) break
      const item = this.parseUtilityItem()
      if (item.modifier) {
        this.error(`Modifiers are not allowed inside keyframes (got '${item.modifier}:' on '${item.name}')`)
      }
      utilities.push(item)
    }

    return { percent, utilities, line }
  }

  // True if the current position begins a new keyframe row (another percent
  // line or a from/to alias). Used to terminate the utility list inside a
  // keyframe without a separator token.
  private isKeyframeBoundary(): boolean {
    if (this.check(TokenType.From) || this.check(TokenType.To)) return true
    if (this.check(TokenType.Number)) {
      const next = this.tokens[this.pos + 1]
      if (next?.type === TokenType.Percent) return true
    }
    return false
  }

  /**
   * Parse a CSS-like style property: fill: stone-800, stroke-width: 1
   * Property names can be hyphen-joined (stroke-width).
   * Values can be hyphen-joined color names, hex colors, numbers, or identifiers.
   */
  private parseStyleProperty(): AST.StyleProperty {
    const line = this.current().line
    // Parse hyphen-joined property name
    let name = this.expectIdentifierOrKeyword()
    while (this.check(TokenType.Minus) && this.tokens[this.pos + 1]?.type === TokenType.Identifier) {
      this.advance() // skip '-'
      name += '-' + this.advance().value
    }
    this.expect(TokenType.Colon)

    // Parse value: hex color, number, bool, function call, or
    // hyphen-joined identifier. Function-call form covers CSS
    // colours: rgb(255,0,0) / rgba(.../.6) / hsl(120,50%,50%) /
    // hsla(...) — the lexer tokenises them as Identifier followed
    // by `(`, so we walk paren-balanced tokens and rebuild the
    // text. resolveColor() then recognises the rebuilt string.
    let value: string
    if (this.check(TokenType.Color)) {
      value = this.advance().value
    } else if (this.check(TokenType.Number)) {
      value = this.advance().value
    } else if (this.check(TokenType.Bool)) {
      value = this.advance().value
    } else if (
      this.check(TokenType.Identifier)
      && this.tokens[this.pos + 1]?.type === TokenType.LParen
    ) {
      value = this.captureFnCallAsString()
    } else {
      // Hyphen-joined name like stone-800, sky-700, white, mercator
      value = this.parseUtilityName()
    }

    return { kind: 'StyleProperty', name, value, line }
  }

  /** Walk paren-balanced tokens and rebuild the source text — used
   *  to capture function-call syntax in StyleProperty values (e.g.
   *  `rgb(255, 0, 0, 0.6)`) without committing to a structured
   *  expression representation. The resulting string is fed back to
   *  the CSS-style colour resolver in lower.ts. */
  private captureFnCallAsString(): string {
    let raw = this.advance().value // fn name
    if (!this.check(TokenType.LParen)) return raw
    raw += '('
    this.advance()
    let depth = 1
    while (depth > 0 && !this.isEnd()) {
      const t = this.current()
      if (t.type === TokenType.LParen) { depth++; raw += '('; this.advance(); continue }
      if (t.type === TokenType.RParen) {
        depth--
        raw += ')'
        this.advance()
        if (depth === 0) break
        continue
      }
      // Tokens like commas / numbers / percent / identifiers all
      // come through with their raw `value` field already set, so
      // joining them back yields a usable source-text stand-in.
      raw += t.value
      this.advance()
    }
    return raw
  }

  /**
   * Check if current position starts a CSS-like style property in a layer block.
   * Detects: fill:, stroke:, stroke-width:, opacity:, size:
   */
  private isStylePropertyStart(): boolean {
    if (this.current().type !== TokenType.Identifier) return false
    const name = this.current().value
    const next = this.tokens[this.pos + 1]

    if ((name === 'fill' || name === 'opacity' || name === 'size') && next?.type === TokenType.Colon) {
      return true
    }
    if (name === 'stroke') {
      if (next?.type === TokenType.Colon) return true
      // stroke-width: pattern
      if (next?.type === TokenType.Minus) {
        const next2 = this.tokens[this.pos + 2]
        const next3 = this.tokens[this.pos + 3]
        return next2?.type === TokenType.Identifier && next2.value === 'width' &&
               next3?.type === TokenType.Colon
      }
    }
    return false
  }

  /** Parse key: number pairs like "x: 0.5 y: -1 w: 2 h: 1.4" */
  private parseNumericProps(): Record<string, number> {
    const props: Record<string, number> = {}
    // Parse key: value pairs until we hit a non-identifier or a keyword like 'path', 'rect', 'circle', 'anchor'
    while (
      this.check(TokenType.Identifier) &&
      this.tokens[this.pos + 1]?.type === TokenType.Colon &&
      !['path', 'rect', 'circle', 'anchor'].includes(this.current().value)
    ) {
      const key = this.advance().value
      this.expect(TokenType.Colon)
      // Handle negative numbers
      let sign = 1
      if (this.check(TokenType.Minus)) {
        this.advance()
        sign = -1
      }
      const num = parseFloat(this.expect(TokenType.Number).value)
      props[key] = sign * num
    }
    return props
  }

  // key: value (used in source and layer blocks)
  // Uses parseCoalesce() instead of parseExpr() to avoid consuming
  // `|` as the pipe operator. parseCoalesce wraps parseLogicalOr
  // and adds `??` support — required for things like
  // `extrude: .height ?? 50` inside a layer body. Walking up to
  // parsePipe / parseExpr would also pull in the pipe operator
  // and break the `layer x { ... | fill-... }` grammar.
  private parseBlockProperty(): AST.BlockProperty {
    const line = this.current().line
    const name = this.expectIdentifierOrKeyword()
    this.expect(TokenType.Colon)
    const value = this.parseCoalesce()
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
    // Fractional zoom modifier: `z15.5:fill-…` — the lexer splits
    // that into Identifier("z15") Dot Number("5") Colon, so we
    // detect the 4-token shape here and reassemble it. Only zoom
    // modifiers are fractional today; no other modifier name uses
    // a dot, so the `^z\d+$` gate is enough to disambiguate.
    if (this.isFractionalZoomModifier()) {
      const intPart = this.advance().value          // "z15"
      this.advance()                                  // '.'
      const fracPart = this.advance().value          // "5"
      this.expect(TokenType.Colon)
      modifier = `${intPart}.${fracPart}`
    } else if (this.isModifierPattern()) {
      modifier = this.advance().value // consume the modifier identifier
      this.expect(TokenType.Colon)    // consume ':'
    }

    // Parse the utility name: hyphen-joined tokens like "fill-red-500", "stroke-2"
    const name = this.parseUtilityName()

    // Check for data binding: -[expr] or [expr] or fill match(...){...} / categorical(...) / gradient(...)
    let binding: AST.Expr | null = null

    // New syntax: fill match(field) { ... }, fill categorical(field), fill gradient(field, ...)
    const DATA_STYLE_PROPS = ['fill', 'stroke', 'opacity']
    const DATA_STYLE_FNS = ['match', 'categorical', 'gradient']
    if (DATA_STYLE_PROPS.includes(name) && this.check(TokenType.Identifier) &&
        DATA_STYLE_FNS.includes(this.tokens[this.pos]?.value)) {
      binding = this.parseExpr()
      // If it's match(...), check for trailing { ... } match block
      if (binding.kind === 'FnCall' && binding.callee.kind === 'Identifier' &&
          binding.callee.name === 'match' && this.check(TokenType.LBrace)) {
        binding.matchBlock = this.parseMatchBlock()
      }
    }
    // Handle size-[speed], fill-[expr] patterns: minus followed by bracket
    else if (this.check(TokenType.Minus) && this.tokens[this.pos + 1]?.type === TokenType.LBracket) {
      this.advance() // skip '-'
      this.advance() // skip '['
      binding = this.parseExpr()
      this.expect(TokenType.RBracket)
    } else if (this.check(TokenType.LBracket)) {
      this.advance() // skip [
      binding = this.parseExpr()
      this.expect(TokenType.RBracket)
    }

    // Check for trailing unit after ] — e.g., size-[expr]km
    let bindingUnit: string | null = null
    if (binding) {
      const unitTypes = [TokenType.Px, TokenType.M, TokenType.Km, TokenType.Nm, TokenType.Deg]
      if (unitTypes.includes(this.current().type)) {
        bindingUnit = this.advance().value
      } else if (this.check(TokenType.Identifier)) {
        const v = this.current().value
        if (['px', 'm', 'km', 'nm', 'deg'].includes(v)) {
          bindingUnit = this.advance().value
        }
      }
    }

    return { kind: 'UtilityItem', modifier, name, binding, bindingUnit }
  }

  /**
   * Parse a hyphen-joined utility name like "fill-red-500", "stroke-white", "opacity-80".
   * Consumes: Identifier/Number/Color tokens joined by Minus tokens.
   */
  /** Check if token can start or continue a utility name (identifiers + keywords used as names) */
  private isUtilityNameToken(): boolean {
    const t = this.current().type
    return t === TokenType.Identifier || t === TokenType.SymbolDef ||
      t === TokenType.Source || t === TokenType.Layer || t === TokenType.Preset ||
      t === TokenType.View || t === TokenType.On ||
      // Short keywords that naturally appear inside utility names, e.g.
      // `ease-in-out`, `ease-in`, `from-red-500`, `to-blue-500`, `fade-in`.
      // Without these, `in` / `from` / `to` would short-circuit the
      // hyphen-joined name accumulator and break utility parsing.
      t === TokenType.In || t === TokenType.From || t === TokenType.To
  }

  private parseUtilityName(): string {
    let name = ''

    // First token must be an identifier or keyword used as utility name
    if (this.isUtilityNameToken()) {
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
      if (!next) break
      const isNamePart = next.type === TokenType.Identifier ||
        next.type === TokenType.Number ||
        next.type === TokenType.Color ||
        next.type === TokenType.SymbolDef ||
        next.type === TokenType.Source ||
        next.type === TokenType.Layer ||
        // Short keywords that appear mid-name: ease-in-out, ease-in,
        // from-red-500, to-blue-500, fade-in, etc.
        next.type === TokenType.In ||
        next.type === TokenType.From ||
        next.type === TokenType.To
      if (!isNamePart) break
      this.advance() // consume '-'
      name += '-' + this.advance().value
    }

    // Absorb trailing unit token (px, m, km, etc.) into name
    // e.g., size-500 + km → "size-500km"
    if (this.check(TokenType.Px) || this.check(TokenType.M) ||
        this.check(TokenType.Km) || this.check(TokenType.Nm) ||
        this.check(TokenType.Deg)) {
      name += this.advance().value
    }

    return name
  }

  /**
   * Parse match block: { "KOR" -> red-500, "JPN" -> blue-500, _ -> gray-300 }
   */
  private parseMatchBlock(): AST.MatchBlock {
    this.expect(TokenType.LBrace)
    const arms: AST.MatchArm[] = []

    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      // Pattern: string literal, identifier, or '_' for default
      let pattern: string
      if (this.check(TokenType.String)) {
        pattern = this.advance().value
      } else if (this.check(TokenType.Identifier)) {
        pattern = this.advance().value
      } else {
        break
      }

      // Arrow: ->
      this.expect(TokenType.Arrow)

      // Value parsing — three shapes:
      //   #abcdef               → ColorLiteral
      //   red-500 / gray-300    → utility-name Identifier (only when
      //                           an Identifier is followed by `-`)
      //   true / 42 / "x" / .f  → general expression (parseCoalesce
      //                           so `??` works; we deliberately stay
      //                           below the pipe operator like
      //                           parseBlockProperty does)
      let value: AST.Expr
      if (this.check(TokenType.Color)) {
        value = { kind: 'ColorLiteral', value: this.advance().value }
      } else if (this.check(TokenType.Identifier) &&
                 this.tokens[this.pos + 1]?.type === TokenType.Minus) {
        const colorName = this.parseUtilityName()
        value = { kind: 'Identifier', name: colorName }
      } else {
        value = this.parseCoalesce()
      }

      arms.push({ pattern, value })

      // Optional comma/newline separator
      if (this.check(TokenType.Comma)) this.advance()
    }

    this.expect(TokenType.RBrace)
    return { kind: 'MatchBlock', arms }
  }

  /** Lookahead for the fractional zoom modifier `z<int>.<digits>:`.
   *  The lexer splits these as four tokens — see parseUtilityItem
   *  for the matching consumer. */
  private isFractionalZoomModifier(): boolean {
    if (!this.check(TokenType.Identifier)) return false
    const cur = this.current().value
    if (!/^z\d+$/.test(cur)) return false
    const t1 = this.tokens[this.pos + 1]
    const t2 = this.tokens[this.pos + 2]
    const t3 = this.tokens[this.pos + 3]
    const t4 = this.tokens[this.pos + 4]
    return !!(t1 && t1.type === TokenType.Dot &&
              t2 && t2.type === TokenType.Number &&
              t3 && t3.type === TokenType.Colon &&
              t4 && t4.type === TokenType.Identifier)
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
      token.type === TokenType.Style ||
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
    const expr = this.parsePipe()
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

  // expr | transform | transform
  private parsePipe(): AST.Expr {
    let left = this.parseCoalesce()

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

  // ?? — null/undefined/missing fallback. Sits between pipe (`|`)
  // and `||` in precedence so `.height ?? 50` parses as a single
  // BinaryExpr without paren juggling, and `a || b ?? c` parses
  // as `(a || b) ?? c` (the `||` binds tighter, like JS where the
  // two cannot mix without parens but this engine resolves with a
  // flat lower-precedence rule). Right-associative chaining via
  // the while-loop below: `.h ?? .level * 3 ?? 50` walks
  // left→right, binding the rightmost first thanks to the chain.
  private parseCoalesce(): AST.Expr {
    let left = this.parseLogicalOr()
    while (this.check(TokenType.QuestionQuestion)) {
      const op = this.advance().value
      const right = this.parseLogicalOr()
      left = { kind: 'BinaryExpr', op, left, right }
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
        const call: AST.FnCall = { kind: 'FnCall', callee: expr, args }
        // `match(field) { "k" -> v, _ -> default }` — the trailing
        // block is part of the match expression. Originally only
        // recognized inside utility-item position (parseUtilityItem),
        // but a value-mapping match makes sense in any expression
        // context (filter:, paint utility brackets, ternaries…), so
        // pick up the block uniformly here.
        if (call.callee.kind === 'Identifier' && call.callee.name === 'match' &&
            this.check(TokenType.LBrace)) {
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
