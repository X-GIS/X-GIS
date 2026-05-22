<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# lexer

## Purpose
First stage of the compile pipeline. Turns a raw `.xgis` source string into a flat `Token[]` for the parser. The lexer is a hand-written single-pass scanner tracking `line`/`col` for diagnostics; it recognizes numbers (incl. scientific notation), strings, hex colors (`#ff0000`/`#ccc`), booleans, identifiers, the X-GIS keyword set, unit suffixes (`px`, `m`, `km`, `%`, …), operators, and both comment styles (`//`, `/* */`).

## Key Files
| File | Description |
|------|-------------|
| `lexer.ts` | The `Lexer` class. `new Lexer(src).tokenize()` → `Token[]`. Skips whitespace/comments, emits `Newline` tokens (the parser filters them), and dispatches per leading char to string/color/number/identifier scanners. |
| `tokens.ts` | `TokenType` enum (literals, keywords like `let`/`fn`/`show`/`source`/`layer`/`symbol`/`keyframes`, units, operators), the `Token` interface, and `lookupKeyword` / `lookupUnit` tables that classify identifiers and unit suffixes. |

## For AI Agents

### Working In This Directory
- Adding a keyword requires three edits: a `TokenType` enum member, an entry in the `lookupKeyword` table, and parser handling. The token comment column documents the literal each member represents — keep it.
- Newlines ARE emitted as tokens but are NOT syntactically significant; the parser drops them in its constructor. Don't add newline-sensitivity here.
- `lookupUnit` maps unit suffixes to token types; numbers + units are lexed adjacently and combined downstream.

### Testing Requirements
- `src/__tests__/lexer.test.ts` and `lexer-scientific-notation.test.ts` cover tokenization. There is no colocated test in this dir; tests live under `__tests__/`.

### Common Patterns
- Pure character scanning with `peek(n)` lookahead; `push(type, value)` records `line`/`col` captured before advancing.

## Dependencies

### Internal
- `tokens.ts` is imported by `lexer.ts` and by `parser/`.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
