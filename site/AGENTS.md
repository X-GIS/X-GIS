<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-29 -->

# site

## Purpose

Astro 5 static documentation and marketing site for X-GIS, deployed to GitHub Pages at `x-gis.github.io/X-GIS`. Holds the public landing page (`/`), a "why" narrative page (`/why`), full docs section (quickstart, language reference, API reference, concepts, cookbook, Mapbox migration guide, glossary), a dedicated shader-DSL section (`/shader-dsl/*`: index, getting-started, concepts, reference, examples), an in-site React-island playground (`/play`), a live examples gallery deep-linking into the standalone playground, a Mapbox-style JSON converter (`/convert`), the Blueprint visual node-editor page (`/blueprint`), a blog (`/blog`), and a Korean landing variant (`/ko`). Uses the `@astrojs/react` integration for React islands (Hero, Playground, GlobeDemo). Imports `@xgis/compiler`, `@xgis/runtime`, and `@xgis/blueprint` directly from the monorepo workspace so pages can embed live engine code client-side. No unit tests; correctness is validated by `astro check` and `astro build`.

## Key Files

| File                                | Description                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `astro.config.mjs`                  | Build config: sets `site`/`base` for GH Pages (`/X-GIS/` in CI, `/` in dev), registers `astro-expressive-code` with the custom `.xgis` Shiki grammar and `github-dark-default` theme, excludes workspace packages from Vite pre-bundling, enables `basicSsl` for local HTTPS (required for WebGPU).                                                      |
| `package.json`                      | `@xgis/site` workspace package. Scripts: `dev`, `build`, `preview`, `check`. Key deps: `astro ^5.1`, `astro-expressive-code ^0.42`, `tailwindcss ^4`, `@xgis/compiler workspace:*`, `@xgis/runtime workspace:*`, `@xgis/blueprint workspace:*`.                                                                                                          |
| `tsconfig.json`                     | Extends `astro/tsconfigs/strict`; adds `jsx: react-jsx` / `jsxImportSource: react` for React components embedded in Astro pages.                                                                                                                                                                                                                         |
| `src/layouts/Base.astro`            | Root HTML shell: viewport meta, canonical URL, Open Graph + Twitter cards, JSON-LD (`SoftwareSourceCode` + `WebSite` schema), Inter + Geist Mono variable fonts (self-hosted via `@fontsource-variable`, imported in `global.css`), mobile nav drawer mount point.                                                                                       |
| `src/layouts/Docs.astro`            | Docs page shell: left sidebar nav (activated by `current` prop), right-side TOC, "Last updated" stamp via `gitMeta()`, and "Edit on GitHub" link.                                                                                                                                                                                                        |
| `src/lib/git-meta.ts`               | Build-time helper that shells out to `git log` to produce ISO timestamp, human-relative age, and contributor count for a repo-relative file path. Caches the repo root from `git rev-parse --show-toplevel`.                                                                                                                                             |
| `src/lib/search-index.ts`           | Builds a flat `SearchRecord[]` from `reference-sections.ts` + `gallery-demos.ts` + hand-authored anchor records. Embedded as inline JSON by the `Search` component; client-side fuzzy filter, no external service.                                                                                                                                       |
| `src/lib/xgis-grammar.json`         | TextMate grammar for the `.xgis` style language: tokenises block keywords (`source`, `layer`, `keyframes`, `preset`, `symbol`, `background`), pipe lines, color literals, operators (`??`, `\|`, `?:`), and runtime accessors (`zoom`, `.field`). Used by Shiki for all code blocks; must stay in sync with `vscode-xgis/syntaxes/xgis.tmLanguage.json`. |
| `src/content/gallery-demos.ts`      | Authoritative `Category[]` + `Demo[]` registry for the `/examples` gallery and search index. Each `Demo` carries `id`, optional `runId`, `title`, `body`, `defaultHash`, `devOnly`, and `standaloneUrl`.                                                                                                                                                 |
| `src/content/reference-sections.ts` | Authoritative `ReferenceSection[]` for `/docs/reference`. Each section has `id`, `title`, `body`, a `.xgis` `code` snippet, and optional `demoId`/`demoQuery`/`demoHash` for "Try this" playground deep-links.                                                                                                                                           |
| `src/pages/index.astro`             | Landing page: composes the `Hero` React island plus `WhatIsXGIS`, `HowItCompiles`, `BecomesShaders`, `Coverage`, `Roadmap`, `Showcase`, and `QuickStart` sections inside `<Base>`.                                                                                                                                                                       |
| `src/pages/play.astro`              | In-site "type-and-see" playground: a `<Playground>` React island (hydrated `client:idle`) with a `.xgis` source editor ↔ live `XGISMap` canvas. Distinct from the standalone Vite playground that `/examples` deep-links into.                                                                                                                           |
| `src/pages/examples.astro`          | Gallery page: renders demo cards from `galleryCategories`. Cards deep-link to `/play/demo.html?id=<name>` (the standalone Vite playground merged under `/play/` in prod); dev mode swaps `__PG_HOST__` client-side for LAN access to playground on port 3000.                                                                                            |
| `src/pages/convert.astro`           | Mapbox-style JSON → `.xgis` converter running `@xgis/compiler`'s `mapboxToXgis` pipeline client-side. Preset buttons for OpenFreeMap Liberty/Bright/Positron and MapLibre Demotiles. In prod hands off via `sessionStorage`; in dev uses base64 URL hash.                                                                                                |
| `src/pages/blueprint.astro`         | Embeds `@xgis/blueprint` visual node-editor; hands generated `.xgis` source to the playground via the same `sessionStorage`/hash contract as `convert.astro`.                                                                                                                                                                                            |
| `src/components/Search.astro`       | Client-side fuzzy search over the embedded JSON index; groups results by `type` (`doc` vs `demo`) with tag badges.                                                                                                                                                                                                                                       |
| `src/styles/global.css`             | Tailwind v4 entrypoint; site-wide CSS custom properties (color tokens, typography scale).                                                                                                                                                                                                                                                                |

`src/pages/docs/` contains one `.astro` file per docs page (quickstart, api, reference, expressions, functions, sources, utilities, cookbook, mapbox, mapbox-spec, glossary, index) plus a `concepts/` subfolder (rtc, pipeline, projections, compute, globe). `src/pages/shader-dsl/` is the shader-DSL section (index, getting-started, concepts, reference, examples/index, examples/[id]). `src/components/` holds the remaining UI: page furniture (Header, Footer, MobileNav, MobileNavDrawer, Search), home-page sections (WhatIsXGIS, Why, HowItCompiles, BecomesShaders, Capabilities, Coverage, Roadmap, Showcase, RuntimeSupport, QuickStart, Graticule), docs widgets (Callout, OnThisPage, PageFeedback, SeeAlso, SpecLinks), the `kit/` design-primitive subfolder (Card, ContentBand, Eyebrow, FeatureRow, SectionHead — see `kit/README.md`), the `react/` islands (Hero, Playground, GlobeDemo), and `ui/` shadcn-style primitives (badge, button, card).

## Subdirectories

| Directory | Purpose                                                                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public`  | Static assets: SVG logos, OG image, `robots.txt`, `data/land.geojson` for gallery demos, and `thumbnails/*.jpg` for gallery cards (~50 demo thumbnails). (see `public/AGENTS.md`) |
| `src`     | All Astro source: layouts, pages, components, content registries, lib utilities, and styles. (see `src/AGENTS.md`)                                                                |

## For AI Agents

### Working In This Directory

- `BASE_URL` is `/X-GIS/` in CI and `/` in dev — always use `import.meta.env.BASE_URL` (never hard-code `/X-GIS/`) for internal links and asset paths.
- Workspace packages (`@xgis/compiler`, `@xgis/runtime`, `@xgis/blueprint`) are excluded from Vite's `optimizeDeps`; adding a new workspace import requires the same exclusion entry in `astro.config.mjs`.
- HTTPS (`basicSsl`) is required in dev because WebGPU is only available in secure contexts — `astro dev` without SSL breaks any page that imports `@xgis/runtime`.
- The playground is a separate Vite app (`playground/`), not part of the Astro build. In production both are merged into one GH Pages artifact under `/play/`. Do not add a Vite proxy for the playground URL — the cross-origin redirect via URL hash is the established pattern.
- `gitMeta()` paths must be repo-root-relative (e.g. `'site/src/pages/docs/api.astro'`), not site-relative.
- `src/lib/xgis-grammar.json` token scope names must stay in sync with `vscode-xgis/syntaxes/xgis.tmLanguage.json`.

### Testing Requirements

`@xgis/site` has no Vitest unit tests. Validate changes with:

- `bun run check` (`astro check`) — type-checks all `.astro` + `.ts` files.
- `bun run build` — full static build; catches broken imports, missing types, and Shiki grammar errors.
  Playwright e2e lives in `playground/` (not here) and covers the runtime, not the docs site.

### Common Patterns

- Every docs page passes a `current` string to `<Docs current="concepts/rtc">` so the sidebar highlights the active link.
- New reference entries go in `src/content/reference-sections.ts` (one `ReferenceSection` object); search indexing is automatic via `buildSearchIndex`.
- New gallery demos go in `src/content/gallery-demos.ts` (one `Demo` in the appropriate `Category`); add a `public/thumbnails/<id>.jpg` for the card image, or set `noThumb: true` if a screenshot is not available.
- Code blocks use the `xgis` language identifier (` ```xgis `) to get tokenisation from `xgis-grammar.json`.
- `devOnly: true` on a `Demo` suppresses the gallery card in production but keeps the demo accessible in the playground locally.

## Dependencies

### Internal

- `@xgis/compiler workspace:*` — used client-side in `convert.astro` for Mapbox-style conversion and in the blueprint viewer.
- `@xgis/runtime workspace:*` — imported by pages that embed live maps or expose the JS API reference.
- `@xgis/blueprint workspace:*` — embedded in `blueprint.astro` as the visual node editor.

### External

- `astro ^5.1` — static site framework / build system.
- `astro-expressive-code ^0.42` — syntax-highlighted code blocks with copy buttons and language labels (wraps Shiki).
- `tailwindcss ^4` + `@tailwindcss/vite` — utility CSS, Tailwind v4 Vite plugin (no `tailwind.config.*` file).
- `@astrojs/sitemap ^3.7` — auto-generates `sitemap.xml` at build time.
- `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` — self-hosted variable fonts (no Google Fonts requests).
- `@vitejs/plugin-basic-ssl` — dev-only self-signed TLS cert for local HTTPS / WebGPU access.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
