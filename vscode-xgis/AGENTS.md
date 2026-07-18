<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-03 -->

# vscode-xgis/

## Purpose

VS Code extension that adds language support for `.xgis` files. Provides syntax highlighting via a TextMate grammar and editor behaviour (bracket matching, auto-close, indentation rules) via a language configuration. The extension is a lightweight declarative contribution — no TypeScript activation code, no language server. It can be installed from the extension marketplace or side-loaded with `vsce package`.

## Key Files

| File                            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                  | Extension manifest: language ID `xgis`, file extension `.xgis`, aliases `["X-GIS", "xgis"]`, VS Code engine `^1.80.0`, contributes `languages` + `grammars` entries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `language-configuration.json`   | Editor behaviour: line comments `//`, block comments `/* */`, bracket pairs `{}` `[]` `()`, auto-close pairs, surrounding pairs, indentation increase/decrease rules based on `{` / `}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `syntaxes/xgis.tmLanguage.json` | TextMate grammar (`scopeName: source.xgis`). Tokenises: control keywords (`source`, `layer`, `preset`, `import`, `match`, `symbol`), other keywords (`type`, `url`, `visible`, `hidden`, `filter`), property names (`fill`, `stroke`, `stroke-width`, `opacity`, `size`), built-in functions (`categorical`, `gradient`, `clamp`, `min`, `max`, `sqrt`, `smoothstep`, `mix`, …), Tailwind-style utility classes (`fill-blue-500`, `stroke-red-300`, etc.), field accessors (`.fieldName`), operators (`\|`, `->`, `==`, `!=`, `<=`, `>=`, `&&`, `\|\|`), zoom modifiers (`z14:`), color literals (`#rrggbb`), numbers, strings, block/line comments |

## Subdirectories

| Directory   | Purpose                                          |
| ----------- | ------------------------------------------------ |
| `syntaxes/` | TextMate grammar file (see `syntaxes/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- `syntaxes/xgis.tmLanguage.json` and `site/src/lib/xgis-grammar.json` are parallel copies of the same grammar. When adding new keywords, operators, or token rules to one, apply the identical change to the other. The site uses it for Shiki syntax highlighting in code blocks; VS Code uses it for editor highlighting.
- The extension has no TypeScript source — all contributions are declared in `package.json`. Adding a language server would require a new `extension.ts` entry point and an `activationEvents` entry.
- Scope names follow TextMate conventions: `keyword.control.xgis`, `support.function.xgis`, `variable.other.field.xgis`, `constant.other.color.xgis`, `keyword.operator.pipe.xgis`, etc. Use these consistently so theme authors can target X-GIS tokens.
- VS Code engine requirement is `^1.80.0` — do not raise it unless a newer API is genuinely needed.
- When the `.xgis` language gains new constructs in `compiler/`, update grammar patterns in both parallel copies in the same commit.

### Testing Requirements

- No automated tests. Verify by side-loading: press F5 in VS Code with this folder open to launch an Extension Development Host, open a `.xgis` file, and use "Developer: Inspect Editor Tokens and Scopes" to confirm correct scope assignment.
- After grammar changes, also run `bun dev` from `site/` and verify code blocks render correctly with the updated grammar.

### Common Patterns

- Grammar patterns use `"match"` + `"name"` for single-token rules and `"begin"`/`"end"` for multi-token spans (strings, block comments).
- The `"repository"` section groups rules; top-level `"patterns"` includes them in priority order (comments before strings before keywords avoids false matches inside comments).
- No build step — the extension is pure JSON; `vsce package` bundles it directly.

## Dependencies

### Internal

- `site/src/lib/xgis-grammar.json` — must be kept in sync with `syntaxes/xgis.tmLanguage.json`

### External

- VS Code extension host `^1.80.0`
- `vsce` (optional, for packaging — not in `package.json` devDependencies, install globally if needed)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
