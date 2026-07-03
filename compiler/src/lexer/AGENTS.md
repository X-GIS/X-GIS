<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-23 -->

# lexer

## Purpose

Contains the tokenizer for the `.xgis` style language. `lexer.ts` scans raw source text into a flat `Token[]` array that the parser consumes. `tokens.ts` defines the complete token vocabulary: literals (Number, String, Color `#hex`, Bool), all map-domain keywords (`source`, `layer`, `background`, `show`, `place`, `view`, `keyframes`, `simulate`, `analyze`, `symbol`, `style`, `preset`, …), seven physical-unit suffixes (`px`, `m`, `km`, `nm`, `deg`, `s`, `ms`), and the full operator/punctuation set including `->`, `??`, `..`, and logical operators. This is stage 1 of the compiler pipeline: lexer → parser → IR + passes → codegen → binary.

## Key Files

| File        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`  | Barrel re-export for this module. Exports `Lexer` from `lexer.ts` and `TokenType`, `Token` from `tokens.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tokens.ts` | Defines `TokenType` enum (80 members), the `Token` interface (`type`, `value`, `line`, `col`), and the `KEYWORDS` and `UNITS` lookup tables. Exports `lookupKeyword` (resolves identifier strings to keyword token types or falls back to `Identifier`) and `lookupUnit` (resolves unit suffix strings or returns `null`). Each enum member carries an inline comment with its literal string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `lexer.ts`  | `Lexer` class with a single public `tokenize(): Token[]` method. Hand-written single-pass scanner: skips horizontal whitespace and `\r` (preserves `\n` as `TokenType.Newline`), handles `//` line comments and `/* */` block comments (tracking line/col through newlines inside blocks), reads double-quoted strings with `\n \t \\ \"` escapes, validates `#RGB` / `#RRGGBB` / `#RRGGBBAA` color literals at lex time, reads integers and decimals, handles scientific-notation exponents (`1.5e-7`) to avoid emitting a stray identifier for JSON-origin numbers (iter 542), reads identifiers and resolves them against `KEYWORDS` then `UNITS`, disambiguates `.` vs `..` and all 2-char operators (`==`, `!=`, `<=`, `>=`, `&&`, `\|\|`, `??`, `->`) before 1-char fallback. Throws `[Lexer] … at line N, col N` on any unexpected character or unterminated string. |

## For AI Agents

### Working In This Directory

- Adding a keyword requires three coordinated edits: a `TokenType` enum member in `tokens.ts`, an entry in the `KEYWORDS` table in `tokens.ts`, and a matching `case` in the parser. Keep the inline comment on each enum member — it documents the literal string.
- `Newline` tokens are emitted (not dropped) because the parser uses them for statement termination. Do not silently discard newlines in the lexer.
- Unit suffixes (e.g. `42px`) emit two consecutive tokens — `Number` then the unit token — assembled into a dimensioned value by the parser. Do not merge them into one token without updating the parser.
- Scientific-notation handling (the `e`/`E` branch in `readNumber`) was added at iter 542 for Mapbox-source JSON numbers (e.g. `1.5e-7` for small Mercator deltas). The lookahead guards against consuming `e` if a future unit like `em` is added — preserve that logic.
- Color validation enforces exactly 3, 6, or 8 hex digits after `#` (`#RGB`, `#RRGGBB`, `#RRGGBBAA`). This is a lex-time error, not a parse-time error.
- Match the existing single-pass style: no backtracking, no regex. Keep `pos`, `line`, and `col` in sync on every character consumed.

### Testing Requirements

Unit tests live in `compiler/src/__tests__/lexer.test.ts` (broad token-type coverage) and `compiler/src/__tests__/lexer-scientific-notation.test.ts` (regression for the `e`/`E` exponent path). No tests are colocated in this directory. Run with `vitest` or `bun run test` from the `compiler/` package root. Run `bun run build` after any change — vitest does not typecheck.

### Common Patterns

- All reader methods (`readString`, `readColor`, `readNumber`, `readIdentifier`) capture `startCol` before consuming, then push directly to `this.tokens` rather than returning a value.
- `peek(offset)` returns `''` past end-of-input, enabling safe 2-char lookahead without per-call bounds checks.
- `advance(n)` moves `pos` and `col` together; inline `this.pos++ / this.col++` pairs appear only inside tight while-loops where `advance` would be awkward.
- `this.error()` is typed `never`, so TypeScript narrows control flow correctly after any call — do not change its return type.

## Dependencies

### Internal

- `tokens.ts` is imported by `lexer.ts` here, and by `compiler/src/parser/` downstream.

### External

- None. The lexer has zero npm dependencies.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
