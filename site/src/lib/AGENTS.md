<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# site/src/lib/

## Purpose
Build-time TypeScript utilities and static assets consumed by Astro components and `astro.config.mjs`. Contains the search index builder (flattens docs pages + gallery demos into `SearchRecord[]`, embedded as JSON in the `Search` component for client-side fuzzy filtering), a git metadata reader (`gitMeta(filePath)` shells out to `git log` at build time to return ISO timestamp + relative time + contributor count for each docs page footer), and the `.xgis` Shiki grammar JSON (loaded by `astro-expressive-code` to tokenise `.xgis` code blocks in docs).

## Key Files
| File | Description |
|------|-------------|
| `search-index.ts` | Exports `buildSearchIndex(base): SearchRecord[]` and `buildSearchIndexJSON(base)`. Flattens 13 top-level doc pages, all `referenceSections`, per-section anchor records for functions/expressions/sources/cookbook/mapbox/api, and gallery demos (respecting `devOnly` flag) into one array. `SearchRecord` fields: `id`, `title`, `body`, `type` (`'doc'|'demo'`), `tag`, `url`. |
| `git-meta.ts` | Exports `gitMeta(filePath): Meta` (`iso`, `relative`, `contributors`). Resolves repo root once via `git rev-parse --show-toplevel` (cwd fix — build runs from `site/`), then runs `git log -1 --format=%aI` and `git log --format=%ae` per file. Results are per-process cached in a `Map`. Returns empty `Meta` silently if git is unavailable. |
| `xgis-grammar.json` | TextMate grammar for the `.xgis` language, consumed by `astro-expressive-code` via `shiki.langs` in `astro.config.mjs`; must stay in sync with `vscode-xgis/syntaxes/xgis.tmLanguage.json` (parallel copy). |

## For AI Agents

### Working In This Directory
- `xgis-grammar.json` and `vscode-xgis/syntaxes/xgis.tmLanguage.json` are parallel copies — update both when adding new keywords or token rules.
- `git-meta.ts` uses `child_process.execSync` with an explicit `cwd` pointing at the repo root; without this the build (which runs from `site/`) silently returns empty metadata. If you add new callers, always pass a file path relative to the repo root.
- `gitMeta` returns `{ iso: null, relative: null, contributors: 0 }` in environments without git — callers must handle null values.
- `buildSearchIndex` must be kept in sync with actual docs pages. When a docs page is added or removed, add/remove its record (and any anchor records for H2/H3 sections) here, or it will be invisible to search.
- `buildSearchIndexJSON` wraps `buildSearchIndex` in `JSON.stringify`; callers that need a raw string for `<script type="application/json">` should prefer this over calling both.

### Testing Requirements
- No isolated unit tests. Verified indirectly by `bun run build` — Astro compilation surfaces TypeScript errors and missing content imports at build time.

### Common Patterns
- All exports are pure build-time utilities (no browser APIs). Safe to call from Astro frontmatter.
- `buildSearchIndex` accepts `base: string` (pass `import.meta.env.BASE_URL`) so URLs are prefix-correct in both dev (`/`) and production subdirectory deployments.
- `gitMeta` results are module-level cached so repeated calls within one build are cheap.

## Dependencies

### Internal
- `src/content/gallery-demos.ts` — `galleryCategories`, `runIdOf`
- `src/content/reference-sections.ts` — `referenceSections`

### External
- Node.js `child_process` (`execSync`) — git-meta only
- `astro-expressive-code` / Shiki consume `xgis-grammar.json` via `astro.config.mjs`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
