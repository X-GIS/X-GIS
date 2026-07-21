import { TokenType } from '../lexer/tokens'
import type * as AST from './ast'
import { ExpressionParser } from './parser-expressions'

/** Statement handlers + the keyword→handler registry.
 *
 *  Extends the expression layer (which extends the shared cursor) so
 *  every statement handler shares `this.tokens` / `this.pos` and can
 *  call the precedence ladder (`parseExpr`, `parseCoalesce`, …) and
 *  `parseMatchBlock` / `parseUtilityName` directly. Statement dispatch
 *  is a Map keyed off the lexer token (STATEMENT_HANDLERS); any other
 *  token at statement position is a syntax error — the language has no
 *  top-level expression statements (#1072). */
export class StatementParser extends ExpressionParser {
  protected parseStatement(): AST.Statement {
    const token = this.current()
    const handler = STATEMENT_HANDLERS.get(token.type)
    if (handler) return handler(this)
    this.error(
      `Expected a top-level statement (source, layer, background, preset, ` +
        `import, symbol, or keyframes), got ${TokenType[token.type]} ('${token.value}')`,
    )
  }

  // source name { key: value, ... }
  parseSourceStatement(): AST.SourceStatement {
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
  parseLayerStatement(): AST.LayerStatement {
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
  parseBackgroundStatement(): AST.BackgroundStatement {
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
  parsePresetStatement(): AST.PresetStatement {
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
  parseImportStatement(): AST.ImportStatement {
    const line = this.current().line
    this.expect(TokenType.Import)

    // Three shapes:
    //   1. import { name1, name2 } from "file.xgis"   ← cherry-pick
    //   2. import "url-or-path"                       ← splice all
    //   3. import * as ns from "file.xgis"            ← namespaced splice
    //
    // Splice form treats the URL's content as a sub-program and prepends
    // every top-level statement. The async resolver auto-detects Mapbox
    // style.json (starts with `{`) and runs convertMapboxStyle before
    // re-parsing as xgis — letting devs drop a Mapbox base style in
    // with one line and override layers below.

    // Shape 3: `import * as ns from "..."`. `as` is not a reserved keyword, so
    // it lexes as an Identifier — matched by value, keeping this a parser-only
    // production with no lexer/token change.
    if (this.check(TokenType.Star)) {
      this.advance() // consume '*'
      const asTok = this.expect(TokenType.Identifier)
      if (asTok.value !== 'as') {
        this.error(`Expected 'as' in \`import * as <ns> from "..."\`, got '${asTok.value}'`)
      }
      const namespace = this.expect(TokenType.Identifier).value
      this.expect(TokenType.From)
      const path = this.expect(TokenType.String).value
      return { kind: 'ImportStatement', names: [], path, line, namespace }
    }

    if (this.check(TokenType.String)) {
      const path = this.expect(TokenType.String).value
      return { kind: 'ImportStatement', names: [], path, line }
    }

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
  parseSymbolStatement(): AST.SymbolStatement {
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

  // keyframes pulse { 0%: opacity-100  50%: opacity-30  100%: opacity-100 }
  //
  // Each keyframe: <percent>%: utility utility ...   or   from: ... / to: ...
  // Utilities inside a keyframe must NOT carry modifiers (z8:, hover:, etc.) —
  // a keyframe already IS a point in time, so any modifier would be ambiguous.
  parseKeyframesStatement(): AST.KeyframesStatement {
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
      this.error(
        `Expected percent, 'from', or 'to' in keyframe, got ${TokenType[this.current().type]}`,
      )
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
        this.error(
          `Modifiers are not allowed inside keyframes (got '${item.modifier}:' on '${item.name}')`,
        )
      }
      utilities.push(item)
    }

    return { percent, utilities, line }
  }

  // True if the current position begins a new keyframe row (another percent
  // line or a from/to alias). Used to terminate the utility list inside a
  // keyframe without a separator token.
  private isKeyframeBoundary(): boolean {
    // `from` / `to` open a new row ONLY in the selector form `from:` / `to:`
    // (grammar: `frame-selector ":"`). A bare `from` / `to` that is NOT
    // followed by a colon is a utility-name segment (`from-red-500`,
    // `to-blue-500`) and must stay inside the current row's utility list.
    if (this.check(TokenType.From) || this.check(TokenType.To)) {
      return this.tokens[this.pos + 1]?.type === TokenType.Colon
    }
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
    while (
      this.check(TokenType.Minus) &&
      this.tokens[this.pos + 1]?.type === TokenType.Identifier
    ) {
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
      this.check(TokenType.Identifier) &&
      this.tokens[this.pos + 1]?.type === TokenType.LParen
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
      if (t.type === TokenType.LParen) {
        depth++
        raw += '('
        this.advance()
        continue
      }
      if (t.type === TokenType.RParen) {
        depth--
        raw += ')'
        this.advance()
        if (depth === 0) break
        continue
      }
      // Re-insert a separator (lexer drops whitespace) so space-separated CSS
      // colour fns like `oklab(0.5 -0.05 0.1)` don't collapse to `0.5-0.050.1`
      // (→ parseCssColorFn <3 parts → null). Skip after `(`, before a comma,
      // and after `-` (keep a negative channel glued: `-0.05`).
      const last = raw[raw.length - 1]
      if (last !== '(' && last !== '-' && t.type !== TokenType.Comma) {
        raw += ' '
      }
      raw += t.value
      this.advance()
    }
    return raw
  }

  /**
   * Check if current position starts a CSS-like style property in a layer block.
   * Detects: fill:, stroke:, stroke-width:, opacity:, size:, pattern:
   */
  private isStylePropertyStart(): boolean {
    if (this.current().type !== TokenType.Identifier) return false
    const name = this.current().value
    const next = this.tokens[this.pos + 1]

    // `pattern:` — the background directive's sprite-name style property
    // (#777 I-E background-pattern); parses through the same parseStyleProperty
    // value path as fill/opacity.
    if (
      (name === 'fill' || name === 'opacity' || name === 'size' || name === 'pattern') &&
      next?.type === TokenType.Colon
    ) {
      return true
    }
    if (name === 'stroke') {
      if (next?.type === TokenType.Colon) return true
      // stroke-width: pattern
      if (next?.type === TokenType.Minus) {
        const next2 = this.tokens[this.pos + 2]
        const next3 = this.tokens[this.pos + 3]
        return (
          next2?.type === TokenType.Identifier &&
          next2.value === 'width' &&
          next3?.type === TokenType.Colon
        )
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
  // Uses parseCoalesce() instead of parseExpr(), which keeps `??`
  // (`extrude: .height ?? 50`) but not the ternary. The original
  // reason — keeping `|` out of expression position — is moot since
  // the expression pipe operator was removed (#1238), but the accepted
  // block-value grammar is deliberately left unchanged by that removal.
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
    while (!this.check(TokenType.Pipe) && !this.check(TokenType.RBrace) && !this.isEnd()) {
      items.push(this.parseUtilityItem())
    }

    return { kind: 'UtilityLine', items, line }
  }

  // Parse a single utility item like "fill-red-500", "z8:opacity-40", "size-[expr]"
  private parseUtilityItem(): AST.UtilityItem {
    let modifier: string | null = null

    // Check for modifier pattern: identifier:identifier-...
    // e.g., friendly:fill-green-500, hover:glow-8.
    // (Zoom modifiers `z14:` were removed in favour of
    // `opacity-[interpolate(zoom, …)]` — see lower.ts.)
    if (this.isModifierPattern()) {
      modifier = this.advance().value // consume the modifier identifier
      this.expect(TokenType.Colon) // consume ':'
    }

    // Parse the utility name: hyphen-joined tokens like "fill-red-500", "stroke-2"
    const name = this.parseUtilityName()

    // Check for data binding: -[expr] or [expr] or fill match(...){...} / categorical(...) / gradient(...)
    let binding: AST.Expr | null = null

    // New syntax: fill match(field) { ... }, fill categorical(field), fill gradient(field, ...)
    const DATA_STYLE_PROPS = ['fill', 'stroke', 'opacity']
    const DATA_STYLE_FNS = ['match', 'categorical', 'gradient']
    if (
      DATA_STYLE_PROPS.includes(name) &&
      this.check(TokenType.Identifier) &&
      DATA_STYLE_FNS.includes(this.tokens[this.pos]?.value)
    ) {
      // parseCoalesce, NOT parseExpr — the standing block-property rule
      // (see parseBlockProperty): parsePostfix consumes `match(...) { … }`
      // including its arm block, so a following `|` that starts the NEXT
      // utility line must not be swallowed as an expression pipe (#1236 —
      // "Expected utility name, got Minus" on `| stroke-white` after a
      // match-block utility).
      binding = this.parseCoalesce()
      // If it's match(...), check for trailing { ... } match block
      if (
        binding.kind === 'FnCall' &&
        binding.callee.kind === 'Identifier' &&
        binding.callee.name === 'match' &&
        this.check(TokenType.LBrace)
      ) {
        binding.matchBlock = this.parseMatchBlock()
      }
    }
    // Handle size-[speed], fill-[expr] patterns: minus followed by bracket
    else if (
      this.check(TokenType.Minus) &&
      this.tokens[this.pos + 1]?.type === TokenType.LBracket
    ) {
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
      const unitTypes = [
        TokenType.Px,
        TokenType.M,
        TokenType.Km,
        TokenType.Nm,
        TokenType.Deg,
        TokenType.S,
        TokenType.Ms,
      ]
      if (unitTypes.includes(this.current().type)) {
        bindingUnit = this.advance().value
      } else if (this.check(TokenType.Identifier)) {
        const v = this.current().value
        if (['px', 'm', 'km', 'nm', 'deg', 's', 'ms'].includes(v)) {
          bindingUnit = this.advance().value
        }
      }
    }

    return { kind: 'UtilityItem', modifier, name, binding, bindingUnit }
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
      token.type === TokenType.Layer
    ) {
      this.advance()
      return token.value
    }
    return this.expect(TokenType.Identifier).value
  }
}

/** keyword (lexer TokenType) → statement handler. Any token not in
 *  this map is a syntax error at statement position (#1072). */
type StatementHandler = (p: StatementParser) => AST.Statement

const STATEMENT_HANDLERS: ReadonlyMap<TokenType, StatementHandler> = new Map<
  TokenType,
  StatementHandler
>([
  [TokenType.Source, (p) => p.parseSourceStatement()],
  [TokenType.Layer, (p) => p.parseLayerStatement()],
  [TokenType.Background, (p) => p.parseBackgroundStatement()],
  [TokenType.Preset, (p) => p.parsePresetStatement()],
  [TokenType.Import, (p) => p.parseImportStatement()],
  [TokenType.SymbolDef, (p) => p.parseSymbolStatement()],
  [TokenType.Keyframes, (p) => p.parseKeyframesStatement()],
])

/** The keyword tokens that begin a top-level statement — the resume
 *  points the error-recovery `synchronize()` (parser.ts) skips forward
 *  to. Derived from the handler registry so a new statement keyword is a
 *  recovery target by construction (single authority). */
export const STATEMENT_START_TOKENS: ReadonlySet<TokenType> = new Set(STATEMENT_HANDLERS.keys())
