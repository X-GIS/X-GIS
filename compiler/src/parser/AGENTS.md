<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-29 -->

# parser

## Purpose
Second stage of the X-GIS compiler pipeline. Consumes the `Token[]` stream produced by the lexer and emits a fully typed AST (`Program` → `Statement[]` → `Expr` trees). The `Parser` class is a recursive-descent implementation that filters `Newline` tokens at construction time and handles every X-GIS statement form: `let`, `show`, `source`, `layer`, `background`, `preset`, `fn`, `symbol`, `style`, `keyframes`, `import`, `if`/`else if`/`else`, `for`, and `return`. Expression parsing uses a Pratt/precedence-climbing chain (`parsePipe` → `parseCoalesce` → `parseLogicalOr` → … → `parsePrimary`) covering ternary, `??`, `||`, `&&`, comparison, additive, multiplicative, unary, and postfix (calls, dot-access, array-index). A standalone `parseExpressionString()` export lets the IR lowering pass re-parse expressions embedded in label string templates (e.g. `{lat:.4f}°N`). No subdirectories.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Barrel re-export: exports `Parser` from `parser.ts` and all AST types (`export type *`) from `ast.ts`. |
| `parser.ts` | The `Parser` class (`extends StatementParser`) and `parseExpressionString(src)` helper. `parse()` returns a `Program`; `parseSingleExpression()` parses exactly one `Expr` and throws on trailing tokens (used by `ir/lower.ts` for template interpolations). `parseBlockProperty()` deliberately stops at `parseCoalesce` rather than `parseExpr` so the `|` pipe operator is never consumed inside `layer`/`source` block values. `isStylePropertyStart()` uses a 2-token lookahead to distinguish CSS-style `fill: stone-800` from generic `key: expr` block properties. `captureFnCallAsString()` walks paren-balanced tokens to capture `rgb()`/`rgba()`/`hsl()` CSS color calls as raw strings for the downstream color resolver. |
| `parser-cursor.ts` | `ParserCursor` base class — owns `this.tokens` / `this.pos` and the low-level traversal + lookahead utilities. Filters `Newline` tokens in its constructor. Both the statement handlers and the expression precedence ladder extend this so they share one cursor. |
| `parser-expressions.ts` | `ExpressionParser extends ParserCursor` — the Pratt/precedence-climbing expression ladder (`parsePipe` → `parseCoalesce` → … → `parsePrimary`). |
| `parser-statements.ts` | `StatementParser extends ExpressionParser` — the statement-form handlers (keyword→handler dispatch) for `let`/`show`/`source`/`layer`/`background`/`preset`/`fn`/`symbol`/`style`/`keyframes`/`import`/`if`/`for`/`return`. |
| `ast.ts` | All AST node type definitions. `Statement` is a union of 14 forms (`LetStatement`, `ShowStatement`, `FnStatement`, `ExprStatement`, `SourceStatement`, `LayerStatement`, `BackgroundStatement`, `PresetStatement`, `ImportStatement`, `SymbolStatement`, `StyleStatement`, `KeyframesStatement`, `IfStatement`, `ReturnStatement`, `ForStatement`). `Expr` covers 13 node kinds including `PipeExpr`, `MatchBlock`/`MatchArm`, `FieldAccess` (with `object: null` for implicit `.field` data binding), `ConditionalExpr`, and `ArrayAccess`. `UtilityItem` carries an optional `modifier` (for `friendly:fill-green-500` conditional styling), a hyphen-joined `name`, an optional `binding: Expr` (for `size-[expr]`), and an optional `bindingUnit`. `KeyframesStatement` sorts frames by `percent` after parsing. Every statement node carries `line` for diagnostics. |

## For AI Agents

### Working In This Directory
- AST nodes are discriminated unions keyed on `kind` (e.g. `'LetStatement'`). Adding a new construct requires: a new type in `ast.ts`, membership in the `Statement` or `Expr` union, and either a statement handler in `parser-statements.ts` (registered in the keyword→handler map) or a level in the `parser-expressions.ts` precedence ladder. `parser.ts` is now a THIN driver over the shared `parser-cursor.ts` token cursor (Tier-C5 split) — do not re-inline statement/expression parsing into it.
- The parser silently drops `Newline` tokens in its constructor — X-GIS statement boundaries come entirely from the grammar, not from newlines. Do not add newline-sensitivity.
- `parseBlockProperty()` calls `parseCoalesce()` (not `parseExpr()`) to prevent `|` from being consumed as a pipe operator inside `layer`/`source` block values. Any new block-property-like production must follow the same rule.
- `parseExpressionString()` is the public contract for `ir/lower.ts`; it must always throw on trailing tokens rather than silently ignoring them.
- `import` supports two shapes: `import { name1, name2 } from "file.xgs"` (cherry-pick) and `import "url-or-path"` (splice-all). The splice form auto-detects Mapbox `style.json` (starts with `{`) and routes through `convertMapboxStyle` before re-parsing.
- Utility names are hyphen-joined across `Identifier`, `Number`, `Color`, `Bool`, and several short keywords (`In`, `From`, `To`) to handle names like `ease-in-out`, `from-red-500`, `label-allow-overlap-true`. Extend `isUtilityNameToken()` and the lookahead in `parseUtilityName()` if adding new keyword tokens that can appear mid-name.
- Zoom modifiers (`z14:`) inside utility items were removed in favour of `opacity-[interpolate(zoom, …)]`; the `isModifierPattern()` lookahead still handles non-zoom conditional modifiers (e.g. `friendly:`, `hover:`).

### Testing Requirements
- Fuzz safety: `parser-fuzz.test.ts` (colocated) exercises `parseExpressionString` with malformed inputs. The property is: every input either returns a valid `Expr` or throws — never hangs and never returns `undefined`. Run after any tokenizer or grammar change.
- Unit / integration: `compiler/src/__tests__/parser.test.ts`, `expression-nesting.test.ts`, `keyframes.test.ts` cover statement parsing, expression nesting depth, and the `from`/`to`/`N%` keyframe grammar. Run the full vitest suite (`bun run test` from `compiler/`) after edits.
- Build typecheck: `bun run build` from `compiler/` typechecks via `tsc`; `vitest` alone does not typecheck.

### Common Patterns
- Each AST node type in `ast.ts` is preceded by a comment showing a representative source snippet (e.g. `// let world = load("countries.geojson")`). Add the same doc comment for any new node.
- Error reporting always includes line and column via the shared `error()` helper: `throw new Error(\`[Parser] \${msg} at line \${token.line}, col \${token.col}\`)`.
- Lookahead is done by indexing `this.tokens[this.pos + N]` directly (no backtracking); keep all decision points to ≤ 3 token lookahead.

## Dependencies

### Internal
- Imports `../lexer/tokens` (`TokenType`, `Token`) and `../lexer/lexer` (`Lexer`).
- Produces types consumed by `../ir/lower.ts` (primary consumer of `parseExpressionString` and `Program`), `../eval/`, `../convert/`, and `../schema/`.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
