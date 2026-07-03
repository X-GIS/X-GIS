<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# site/src

## Purpose

All Astro source code for the X-GIS documentation website. Follows the standard Astro project layout: `pages/` (route-mapped `.astro` files covering marketing, docs, shader-dsl, examples, play, blueprint, convert, blog, and a `/ko` locale), `components/` (shared UI pieces, including a `kit/` design-primitive subfolder, a `react/` islands subfolder, and `ui/` shadcn-style primitives), `layouts/` (HTML shell, docs chrome, and the shader-DSL shell), `content/` (typed TypeScript data arrays that are the single source of truth for the examples gallery and the reference section index, plus a `blog/` markdown collection), `lib/` (build-time utilities including the search-index builder, git-metadata helper, shader-example/playground data, `utils.ts`, and the `.xgis` Shiki grammar), and `styles/` (global CSS with Tailwind v4 tokens). Mostly Astro server-rendered with thin `<script>` islands; React islands (via `@astrojs/react`) are used for the live Hero, Playground, and GlobeDemo.

## Key Files

No top-level source files exist directly in `site/src/`; all source is in the subdirectories below.

## Subdirectories

| Directory     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/` | Reusable UI components — page furniture (Header, Footer, Search, MobileNav, MobileNavDrawer), home sections (WhatIsXGIS, Why, HowItCompiles, BecomesShaders, Capabilities, Coverage, Roadmap, Showcase, RuntimeSupport, QuickStart, Graticule), docs widgets (Callout, OnThisPage, PageFeedback, SeeAlso, SpecLinks), plus `kit/` design primitives, `react/` islands (Hero, Playground, GlobeDemo), and `ui/` shadcn-style primitives (see `components/AGENTS.md`, `components/kit/README.md`) |
| `content/`    | Typed TypeScript data: `gallery-demos.ts` (examples gallery cards, single source of truth for `/examples`), `reference-sections.ts` (docs reference sections, single source of truth for `/docs/reference`), and a `blog/` markdown collection (see `content/AGENTS.md`)                                                                                                                                                                                                                        |
| `layouts/`    | `Base.astro` (full HTML shell, meta, fonts), `Docs.astro` (sidebar + TOC chrome used by all `/docs/**` pages), and `ShaderDsl.astro` (shell for the `/shader-dsl/**` section) (see `layouts/AGENTS.md`)                                                                                                                                                                                                                                                                                         |
| `lib/`        | Build-time utilities: `search-index.ts` (aggregates content/ into a flat JSON blob embedded by Search), `git-meta.ts` (shells to `git log` for per-page last-updated stamps, resolves repo root via `git rev-parse`), `shader-examples.ts` / `shader-playground.ts` (shader-DSL data), `utils.ts`, `xgis-grammar.json` (TextMate grammar for `.xgis` Shiki syntax highlighting) (see `lib/AGENTS.md`)                                                                                           |
| `pages/`      | Route-mapped `.astro` files: top-level marketing (`index`, `why`, `examples`, `play`, `blueprint`, `convert`) + `/docs/**` hierarchy (quickstart, api, reference, expressions, functions, sources, utilities, cookbook, glossary, mapbox, mapbox-spec, concepts/{pipeline,projections,rtc,compute,globe}) + `/shader-dsl/**` section + `/blog/**` + `/ko` (see `pages/AGENTS.md`)                                                                                                               |
| `styles/`     | `global.css` — Tailwind v4 base imports + custom design tokens (see `styles/AGENTS.md`)                                                                                                                                                                                                                                                                                                                                                                                                         |

## For AI Agents

### Working In This Directory

- Astro component frontmatter (`---` fences) runs server-side at build time; client-side logic goes in `<script>` tags or via `client:*` directives.
- A `@/*` → `src/*` path alias is configured in `tsconfig.json` (used e.g. by the `kit/` barrel); relative paths are also fine.
- Tailwind v4 is wired via the Vite plugin in `site/astro.config.mjs`; utility classes are available globally without `@apply` in `<style>` blocks.
- `content/gallery-demos.ts` and `content/reference-sections.ts` are the authoritative data sources — both `pages/` and `lib/search-index.ts` import from them. Never duplicate their data inline in page files.
- `lib/git-meta.ts` requires the build to run from inside the git repo so that `git rev-parse --show-toplevel` succeeds; it passes `cwd` explicitly to avoid the `site/` working-directory trap.
- `lib/xgis-grammar.json` is referenced from `site/astro.config.mjs` as the Shiki grammar for `.xgis` code blocks in docs pages.

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
