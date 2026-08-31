import { TokenType } from '../lexer/tokens'
import type * as AST from './ast'
import { StatementParser } from './parser-statements'

/** `terrain { source: dem, exaggeration: 1.5 }` — the Mapbox v3 / MapLibre top-level
 *  terrain block (#2095, T2 Phase 2, docs/plans/2026-08-24-terrain-track.md §Phase 2).
 *
 *  A SEPARATE FILE, not a `parseTerrainStatement` method added to `StatementParser`
 *  (parser-statements.ts) directly: that file sits at `NEW_FILE_CAP` (800/800, zero
 *  headroom) and R4 (the design doc's rejected-alternatives) forbids growing the
 *  equally-exhausted `ir/lower.ts` (1514/1514) the same way — this module is the
 *  sibling both rules steer toward. It extends `StatementParser` rather than being a
 *  free function because the body reuses `parseBlockProperty` (bumped to `protected`
 *  for exactly this), which only a subclass can reach.
 *
 *  SOFT KEYWORD, NOT A RESERVED TOKEN — this is the one deliberate grammar choice this
 *  file makes. `source` / `layer` / `background` / … are reserved at the LEXER
 *  (`lexer/tokens.ts` KEYWORDS), so "source" can never again be an ordinary identifier
 *  anywhere in a program. Doing the same for "terrain" would break real, committed
 *  code: `playground/src/examples/hillshade-terrarium.xgis` and
 *  `hillshade-multidir.xgis` both declare `source terrain { … }` and reference it via
 *  `source: terrain` — a reserved `terrain` token would turn both into parse errors
 *  (`source terrain {` needs an Identifier for the name; `source: terrain` needs one
 *  for the value). So `terrain` is matched by TOKEN VALUE only, at the one position
 *  that decides a NEW top-level statement — exactly the pattern already used for
 *  `return` (fn/stage bodies), `as` (`import * as ns`), and `keep` (import's keep-
 *  clause), per parser-statements.ts's own comments on each. Every OTHER top-level
 *  statement today begins with a reserved keyword token (see STATEMENT_HANDLERS), so a
 *  bare Identifier in statement position was ALREADY a guaranteed syntax error before
 *  this file — this override only fires in a position no valid program could reach,
 *  and cannot un-parse anything that parsed before it. Consequence: `TokenType.Terrain`
 *  does not exist, `lexer/tokens.ts` is untouched, and `sanitizeId`'s XGIS_RESERVED
 *  mirror-list (convert/utils.ts) correctly stays untouched too.
 *
 *  NOT in `STATEMENT_START_TOKENS` (parser-statements.ts's error-recovery resume set):
 *  that set is keyed by `TokenType`, and "terrain" lexes as the same `TokenType.
 *  Identifier` as every other bare word — adding it would make ANY identifier a
 *  synchronize() resume point, degrading recovery for the whole language, not just
 *  this keyword. Left alone deliberately; only affects the multi-error `parseCollect()`
 *  diagnostics path, never the throw-on-first `parse()` the runtime and module
 *  resolver use. */
export class TerrainStatementParser extends StatementParser {
  protected override parseStatement(): AST.Statement {
    const t = this.current()
    if (
      t.type === TokenType.Identifier &&
      t.value === 'terrain' &&
      this.tokens[this.pos + 1]?.type === TokenType.LBrace
    ) {
      return this.parseTerrainStatement()
    }
    return super.parseStatement()
  }

  // terrain { source: dem, exaggeration: 1.5 } — same key:value body shape as
  // `parseSourceStatement`, minus the name. `source:` and `exaggeration:` are
  // ordinary BlockProperty values (Identifier / NumberLiteral respectively); the
  // shape is validated in ir/terrain-block.ts's lowerTerrainBlock, not here — this
  // method only owns the SYNTAX, matching every other *Statement parser in this file.
  private parseTerrainStatement(): AST.TerrainStatement {
    const line = this.current().line
    this.advance() // consume the `terrain` identifier
    this.expect(TokenType.LBrace)
    const properties: AST.BlockProperty[] = []
    while (!this.check(TokenType.RBrace) && !this.isEnd()) {
      properties.push(this.parseBlockProperty())
      if (this.check(TokenType.Comma)) this.advance()
    }
    this.expect(TokenType.RBrace)
    return { kind: 'TerrainStatement', properties, line }
  }
}
