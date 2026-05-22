<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# site/src/lib/

## Purpose
Build-time TypeScript utilities and static assets consumed by Astro components and the Astro config. Contains the search index builder (runs at build time, embedded as JSON in the `Search` component), a git metadata reader (provides last-commit date for the "last updated" footer on docs pages), and the custom `.xgis` Shiki grammar JSON (loaded by `astro.config.mjs` to tokenise `.xgis` code blocks in docs).

## Key Files
| File | Description |
|------|-------------|
| `search-index.ts` | Builds the flat `SearchRecord[]` array from `content/gallery-demos.ts` and `content/reference-sections.ts`; exported as `buildSearchIndex(base)` — called at build time in `Search.astro` |
| `git-meta.ts` | Reads `git log` at build time to return the last-commit ISO date for the current file; used by `Docs.astro` to show "last updated" |
| `xgis-grammar.json` | TextMate grammar for the `.xgis` language, loaded by `astro-expressive-code` via `shiki.langs`; must stay in sync with `vscode-xgis/syntaxes/xgis.tmLanguage.json` |

## For AI Agents

### Working In This Directory
- `xgis-grammar.json` and `vscode-xgis/syntaxes/xgis.tmLanguage.json` are **parallel copies** — update both when adding new keywords or token rules.
- `git-meta.ts` uses `child_process.execSync`; it silently returns `null` in environments without git (CI that checks out without history). Handle the `null` return in callers.
- `search-index.ts` must be kept in sync with the content modules: if a new docs page is added, add a corresponding record here so it appears in search.

### Testing Requirements
- No isolated tests. Verified indirectly by `bun run build` (build-time errors surface as Astro compilation failures).

### Common Patterns
- All functions are pure build-time utilities (no browser APIs). Safe to call in Astro frontmatter.
- `buildSearchIndex` accepts `base: string` (from `import.meta.env.BASE_URL`) so URLs are prefix-correct in both dev and production.

## Dependencies

### Internal
- `src/content/gallery-demos.ts`, `src/content/reference-sections.ts`

### External
- Node.js `child_process` (git-meta only)
- `astro-expressive-code` / Shiki consume `xgis-grammar.json` via `astro.config.mjs`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
