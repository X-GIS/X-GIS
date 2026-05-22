<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# vscode-xgis/syntaxes/

## Purpose
Contains the single TextMate grammar file that defines syntax highlighting for the `.xgis` language in VS Code. The grammar tokenises all language constructs — block keywords, property statements, built-in functions, Tailwind-style utility classes, field accessors, operators, color literals, numbers, strings, and comments — using scope names that standard VS Code themes can colour.

## Key Files
| File | Description |
|------|-------------|
| `xgis.tmLanguage.json` | TextMate grammar (`scopeName: source.xgis`). Patterns (in priority order): comments, strings, colors (`#rrggbb`), numbers, keywords, functions, utilities, field accessors (`.field`), operators (`|>`, `??`, `=>`), modifiers |

## For AI Agents

### Working In This Directory
- This file must be kept in sync with `site/src/lib/xgis-grammar.json`. They serve the same grammar in two contexts (VS Code editor vs. Shiki build-time highlighting on the docs site).
- When the X-GIS language gains new keywords or syntax, update both files in the same commit.
- Validate changes by side-loading the extension (F5 from `vscode-xgis/`) and opening a `.xgis` file; use VS Code's "Developer: Inspect Editor Tokens and Scopes" command to confirm correct scope assignment.

### Testing Requirements
- No automated tests. Manual verification via the VS Code Extension Development Host.

### Common Patterns
- Single-line rules use `"match"` + `"name"`. Multi-line spans (block comments, strings) use `"begin"`/`"end"` with nested `"patterns"`.
- Scope naming: `keyword.control.xgis` for block/control keywords, `support.function.xgis` for built-in functions, `support.class.xgis` for utility classes, `variable.other.field.xgis` for `.fieldName` accessors, `keyword.operator.xgis` for `|>` / `??` / `=>`.

## Dependencies

### Internal
- Referenced by `vscode-xgis/package.json` as the grammar path
- Parallel copy: `site/src/lib/xgis-grammar.json`

### External
- VS Code TextMate grammar engine

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
