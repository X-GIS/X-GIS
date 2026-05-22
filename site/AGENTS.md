<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# site/

## Purpose
Marketing and documentation website for X-GIS, built with Astro 5. Targets `https://x-gis.github.io/X-GIS` on GitHub Pages (base path injected from `GITHUB_ACTIONS` env var). Provides the public landing page, the full language reference, concept guides, API docs, an interactive examples gallery, and a live `.xgis` converter page. The site consumes workspace packages (`@xgis/compiler`, `@xgis/runtime`, `@xgis/blueprint`) directly; Vite excludes them from pre-bundling via `optimizeDeps.exclude`.

## Key Files
| File | Description |
|------|-------------|
| `astro.config.mjs` | Astro config: `@astrojs/sitemap`, `@tailwindcss/vite`, `astro-expressive-code` with custom `.xgis` Shiki grammar loaded from `src/lib/xgis-grammar.json`; workspace package exclusions |
| `package.json` | `@xgis/site` workspace package; scripts: `dev`, `build`, `preview`, `check` |
| `tsconfig.json` | TypeScript config for the site |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `public/` | (see `public/AGENTS.md`) Static assets served as-is |
| `src/` | (see `src/AGENTS.md`) All Astro source: pages, components, layouts, lib, styles |

## For AI Agents

### Working In This Directory
- Run `bun dev` from this directory (not repo root) to start the dev server on `https://localhost:4321`.
- The `base` URL is `/` in dev and `/X-GIS` in CI; use `import.meta.env.BASE_URL` in pages, never hard-code paths.
- The `.xgis` Shiki grammar (`src/lib/xgis-grammar.json`) must be kept in sync with the VS Code extension grammar (`vscode-xgis/syntaxes/xgis.tmLanguage.json`) — they share token scope names.
- Workspace packages are referenced via `workspace:*`; changes in `@xgis/compiler`/`@xgis/runtime` are immediately visible without a separate build step.

### Testing Requirements
- `bun run check` runs `astro check` (TypeScript + Astro diagnostics) — run before committing page or component changes.
- `bun run build` produces the static site in `dist/`; verify it passes before push.
- No Vitest unit tests live here; correctness of runtime behaviour is tested in `runtime/src/__tests__/`.

### Common Patterns
- All docs pages use the `Docs` layout from `src/layouts/Docs.astro`, passing `current` (path after `/docs/`) for sidebar highlighting.
- Navigation cards, search records, and gallery entries are typed in `src/content/`; import from there rather than duplicating strings inline.
- The converter page (`src/pages/convert.astro`) uses a cross-origin redirect to the playground in dev and an iframe in prod — don't add a Vite proxy to `astro.config.mjs` (previous attempt failed due to SSL mismatch).

## Dependencies

### Internal
- `@xgis/compiler` — used on the convert page and in the blueprint viewer
- `@xgis/runtime` — used for live map embeds
- `@xgis/blueprint` — used on `blueprint.astro`

### External
- `astro` ^5.1
- `astro-expressive-code` ^0.42 — syntax-highlighted code blocks with copy button
- `@tailwindcss/vite` ^4 — Tailwind v4 via Vite plugin (no `tailwind.config.*`)
- `@astrojs/sitemap` ^3.7 — auto-generated `sitemap.xml`
- `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` — self-hosted variable fonts

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
