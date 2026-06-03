<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# site/src

## Purpose
All Astro source code for the X-GIS documentation website. Follows the standard Astro project layout: `pages/` (route-mapped `.astro` files covering marketing, docs, examples, blueprint, convert), `components/` (shared UI pieces), `layouts/` (HTML shell and docs chrome), `content/` (typed TypeScript data arrays that are the single source of truth for the examples gallery and the reference section index), `lib/` (build-time utilities including the search-index builder, git-metadata helper, and `.xgis` Shiki grammar), and `styles/` (global CSS with Tailwind v4 tokens). No runtime JavaScript framework — everything is Astro server-rendered with thin `<script>` islands where needed.

## Key Files
No top-level source files exist directly in `site/src/`; all source is in the subdirectories below.

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `components/` | Reusable Astro UI components — Header, Hero, Footer, Search, Callout, Capabilities, Why, Stats, QuickStart, RuntimeSupport, SeeAlso, SpecLinks, OnThisPage, PageFeedback, MobileNav, MobileNavDrawer (see `components/AGENTS.md`) |
| `content/` | Typed TypeScript data: `gallery-demos.ts` (examples gallery cards, single source of truth for `/examples`) and `reference-sections.ts` (docs reference sections, single source of truth for `/docs/reference`) (see `content/AGENTS.md`) |
| `layouts/` | `Base.astro` (full HTML shell, meta, fonts) and `Docs.astro` (sidebar + TOC chrome used by all `/docs/**` pages) (see `layouts/AGENTS.md`) |
| `lib/` | Build-time utilities: `search-index.ts` (aggregates content/ into a flat JSON blob embedded by Search), `git-meta.ts` (shells to `git log` for per-page last-updated stamps, resolves repo root via `git rev-parse`), `xgis-grammar.json` (TextMate grammar for `.xgis` Shiki syntax highlighting) (see `lib/AGENTS.md`) |
| `pages/` | Route-mapped `.astro` files: top-level marketing (`index`, `examples`, `blueprint`, `convert`) + `/docs/**` hierarchy (quickstart, api, reference, expressions, functions, sources, utilities, cookbook, glossary, mapbox, mapbox-spec, concepts/pipeline, concepts/projections, concepts/rtc, concepts/compute) (see `pages/AGENTS.md`) |
| `styles/` | `global.css` — Tailwind v4 base imports + custom design tokens (see `styles/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Astro component frontmatter (`---` fences) runs server-side at build time; client-side logic goes in `<script>` tags or via `client:*` directives.
- No `@/` import alias is configured — use relative paths between subdirectories.
- Tailwind v4 is wired via the Vite plugin in `site/astro.config.ts`; utility classes are available globally without `@apply` in `<style>` blocks.
- `content/gallery-demos.ts` and `content/reference-sections.ts` are the authoritative data sources — both `pages/` and `lib/search-index.ts` import from them. Never duplicate their data inline in page files.
- `lib/git-meta.ts` requires the build to run from inside the git repo so that `git rev-parse --show-toplevel` succeeds; it passes `cwd` explicitly to avoid the `site/` working-directory trap.
- `lib/xgis-grammar.json` is referenced from `site/astro.config.ts` as the Shiki grammar for `.xgis` code blocks in docs pages.

### Testing Requirements
- `bun run check` from `site/` runs the Astro TypeScript checker across all `.astro` files.
- No vitest unit tests live in this directory; correctness is validated by the Astro type checker and Playwright e2e tests in `playground/e2e/`.

### Common Patterns
- Docs pages import `Docs` layout and pass a `current` prop to drive the sidebar active-state highlight.
- The search index is built at `lib/search-index.ts` and embedded as inline JSON by `components/Search.astro` — no external search service, no runtime fetch.
- New docs pages must be added to both `pages/docs/` and to the nav data consumed by `layouts/Docs.astro` to appear in the sidebar.

## Dependencies

### Internal
- `lib/search-index.ts` imports from `content/gallery-demos.ts` and `content/reference-sections.ts`.
- Pages import layouts from `layouts/` and components from `components/`.

### External
- `astro`, `@astrojs/tailwind` / `tailwindcss` (v4), `astro-expressive-code` (code block rendering with Shiki)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
