<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# parser

## Purpose
Second stage of the pipeline. Consumes the lexer's `Token[]` and produces a typed AST (`Program` → `Statement[]` → `Expr` trees). The `Parser` is a recursive-descent parser that filters out `Newline` tokens up front and recognizes every X-GIS construct: `let`, `show`, `source`, `layer`, `background`, `preset`, `fn`, `symbol`, `style`, `keyframes`, `import`, `if`/`else`, `for`, `return`. It also exposes `parseExpressionString()` so the IR lowering pass can re-parse expression sources embedded in text templates (e.g. the `{lat:.4f}` interpolation inside a label string).

## Key Files
| File | Description |
|------|-------------|
| `parser.ts` | The `Parser` class + `parseExpressionString(src)` helper. `parse()` → `Program`; `parseSingleExpression()` parses one expression and throws on trailing tokens (used for template interps and programmatic sub-expressions). |
| `ast.ts` | All AST node type definitions: `Program`, the `Statement` union (`LetStatement`, `ShowStatement`, `SourceStatement`, `LayerStatement`, `KeyframesStatement`, …), `ShowBlock`/`ShowProperty`, and the `Expr` tree. Each node carries `kind` + (where relevant) `line` for diagnostics. |

## For AI Agents

### Working In This Directory
- AST nodes are discriminated unions keyed on `kind` (e.g. `'LetStatement'`). Adding a construct means: a new node type in `ast.ts`, a member in the `Statement`/`Expr` union, and a parse branch in `parser.ts`.
- The parser filters newlines in its constructor, so X-GIS statements are not newline-terminated — boundaries come from the grammar itself.
- `parseExpressionString` is the contract with `ir/lower.ts`; keep its single-expression-only invariant (throws on trailing tokens) intact.

### Testing Requirements
- `src/__tests__/parser.test.ts`, `expression-nesting.test.ts`, `keyframes.test.ts`, and `parser/parser-fuzz.test.ts` (colocated fuzz) cover parsing. Run the fuzz test after any tokenizer/grammar change.

### Common Patterns
- `ast.ts` documents each node with a representative source line in a comment (`// let world = load(...)`). Mirror that style for new nodes.

## Dependencies

### Internal
- Imports `lexer/tokens` + `lexer/lexer`; produces types consumed by `ir/lower.ts`, `eval/`, `convert/`, `schema/`.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
