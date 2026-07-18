<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# vscode-xgis/syntaxes/

## Purpose

Contains the single TextMate grammar file that defines syntax highlighting for the `.xgis` language in VS Code. The grammar tokenises all language constructs — block keywords, property statements, built-in functions, Tailwind-style utility classes, field accessors, operators, zoom-level modifiers, color literals, numbers, strings, and comments — using scope names that standard VS Code themes can colour.

## Key Files

| File                   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xgis.tmLanguage.json` | TextMate grammar (`scopeName: source.xgis`). Ten rule groups in priority order: `comments` (`//` line + `/* */` block), `strings` (double-quoted with escape), `colors` (`#rrggbb`/`#rrggbbaa`), `numbers`, `keywords` (control: `source layer preset import match symbol`; other: `type url visible hidden filter`; property names: `fill stroke stroke-width opacity size`; constants: `true false geojson raster`), `functions` (`categorical gradient match clamp min max abs sqrt log sin cos tan floor ceil round pow step smoothstep mix`), `utilities` (Tailwind color utilities `fill/stroke/bg-<color>-<shade>`, numeric property utilities `opacity/stroke/size/z-order-\d+`, `apply-*` patterns), `fields` (`.fieldName` accessors), `operators` (`\|` pipe, `->` arrow, `_` wildcard, `== != <= >= < > && \|\|` comparisons), `modifiers` (`z\d+:` zoom-level selectors) |

## For AI Agents

### Working In This Directory

- `xgis.tmLanguage.json` must be kept in sync with `site/src/lib/xgis-grammar.json`, which serves the identical grammar for Shiki build-time highlighting on the docs site. Update both files in the same commit whenever the language gains new keywords or syntax constructs.
- Operator set as of 2026-06-03: `|` (pipe), `->` (arrow), `_` (wildcard/catch-all in `match`), and comparison operators. The older `|>`, `??`, `=>` patterns are no longer present.
- Zoom-level selectors (`z14:`, `z0:`, etc.) are tokenised by the `modifiers` rule via `\bz\d+:` — add new zoom-aware syntax here, not under keywords.
- Validate changes by side-loading the extension (F5 from `vscode-xgis/`) and using VS Code "Developer: Inspect Editor Tokens and Scopes" on a `.xgis` file.

### Testing Requirements

- No automated tests. Manual verification via the VS Code Extension Development Host; confirm scope assignments with "Inspect Editor Tokens and Scopes".

### Common Patterns

- Single-line rules use `"match"` + `"name"`. Multi-line spans (`/* */` block comments, double-quoted strings) use `"begin"`/`"end"` with optional nested `"patterns"`.
- Scope naming conventions: `keyword.control.xgis` for block/control keywords, `keyword.other.xgis` for secondary keywords, `support.type.property-name.xgis` for property names before `:`, `constant.language.xgis` for boolean/type literals, `support.function.xgis` for built-in functions, `support.constant.*.xgis` for utility tokens, `variable.other.field.xgis` for `.fieldName`, `keyword.operator.*.xgis` for operators, `keyword.other.modifier.xgis` for zoom modifiers.

## Dependencies

### Internal

- Referenced by `vscode-xgis/package.json` (`contributes.grammars`) as the grammar path
- Parallel copy must stay in sync: `site/src/lib/xgis-grammar.json`

### External

- VS Code TextMate grammar engine (no npm dependencies)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
