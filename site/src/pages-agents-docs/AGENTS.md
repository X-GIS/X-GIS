<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# site/src/pages/

## Purpose
Route-mapped Astro pages that define the site's URL structure. Top-level pages cover the marketing site (home `index`, `why`), the interactive examples gallery, an in-site React-island playground (`play`), a live Mapbox-style-to-.xgis converter, and the Blueprint visual node-editor. The `docs/` sub-tree contains the full documentation hierarchy (quickstart, cookbook, language reference, API, concept guides, Mapbox migration/coverage); the `shader-dsl/` sub-tree is the shader-DSL section (index, getting-started, concepts, reference, examples); `blog/` renders the markdown blog collection; `ko/` is a Korean landing variant.

## Key Files
| File | Description |
|------|-------------|
| `index.astro` | Home page — composes `Hero`, `Why`, and `QuickStart` sections inside `<Base>` layout; the canonical "what is X-GIS" entry point |
| `examples.astro` | Interactive examples gallery — featured "Start here" 3-card section plus full category grid; deep-links into `/play/demo.html?id=…`; handles `devOnly` card filtering and the `__PG_HOST__` LAN-IP swap for playground dev access; thumbnails served from `/thumbnails/<runId>.jpg` |
| `convert.astro` | Live Mapbox Style JSON → `.xgis` converter; preset chips for OpenFreeMap Liberty/Bright/Positron + MapLibre Demotiles; URL fetch or paste input; emits an `import "<url>"` one-liner shortcut; hands off to the playground via `sessionStorage` (prod same-origin) or base64 URL hash (dev cross-origin); imports `convertMapboxStyle` from `@xgis/compiler` as a real ES module so dynamic imports resolve |
| `blueprint.astro` | Blueprint visual node-editor — `BlueprintEditor` canvas with add/undo/redo/fit/snap toolbar; live WebGPU preview pane (runtime dynamically imported on first render); inspector panel; `.xgis` source output; style→graph import from URL or paste; graph persisted to `localStorage`; same dev/prod playground handoff as `/convert` |
| `play.astro` | In-site "type-and-see" playground: a `<Playground>` React island (`client:idle`) pairing a `.xgis` source editor with a live `XGISMap` canvas (distinct from the standalone Vite playground that `/examples` deep-links into) |
| `why.astro` | "Why X-GIS" narrative/positioning page |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `docs/` | Full docs hierarchy — all `/docs/**` routes (see `docs/AGENTS.md`) |
| `shader-dsl/` | Shader-DSL section — `/shader-dsl/**` (index, getting-started, concepts, reference, examples/index, examples/[id]) |
| `blog/` | Blog index + `[...slug]` post pages rendering the `content/blog` collection |
| `ko/` | Korean landing variant (`/ko`) |

## For AI Agents

### Working In This Directory
- Every new top-level page must use `<Base>` (with manual `<Header>`/`<Footer>`) as its root layout; the `<Docs>` layout belongs to `docs/` only.
- `examples.astro` uses an inline `<script is:inline>` to swap `__PG_HOST__` placeholders at runtime — do not remove it; dev access from a LAN IP depends on it.
- `convert.astro` and `blueprint.astro` use regular Astro `<script>` (not `is:inline`, not `define:vars`) so Vite can resolve `@xgis/compiler` and `@xgis/blueprint` as bare workspace specifiers; that distinction is load-bearing.
- `blueprint.astro` dynamically imports `@xgis/runtime` on first render to code-split the heavy WebGPU bundle out of the initial page load.
- Gallery card thumbnails are captured by `playground/e2e/_capture-thumbnails.spec.ts` and land in `site/public/thumbnails/<runId>.jpg`; the base-path prefix is applied automatically via the `${base}/thumbnails` constant.
- Always use `const base = import.meta.env.BASE_URL.replace(/\/+$/, '')` when constructing internal URLs — hardcoded `/` paths break under the `/X-GIS` GH Pages base path.

### Testing Requirements
- `bun run check` (Astro type-check + Vite resolve) validates props and imports across all pages.
- Verify new pages render in `bun dev` before committing; there are no vitest unit tests for page components.
- The playground must be running (`bun run dev` in `playground/`) to test the convert/blueprint "Open in playground" flows in dev mode.

### Common Patterns
- `const base = import.meta.env.BASE_URL.replace(/\/+$/, '')` at the top of any page constructing internal URLs.
- `import.meta.env.DEV` guards dev-only branches (cross-origin playground handoff, `devOnly` card visibility) — these tree-shake in production builds.
- Playground handoff: prod → `sessionStorage` keys `__xgisImportSource` / `__xgisImportLabel` / `__xgisImportSprite` / `__xgisImportGlyphs`; dev → base64 `#src=` URL hash with `?label=` / `?sprite=` / `?glyphs=` query params.

## Dependencies

### Internal
- `src/layouts/Base.astro`
- `src/components/` — Header, Footer, Hero, Why, QuickStart
- `src/content/gallery-demos.ts` — `galleryCategories`, `featuredDemos`, `runIdOf`
- `@xgis/compiler` — `convertMapboxStyle`, `Lexer`, `Parser`
- `@xgis/blueprint` — `BlueprintEditor`, `graphToXgis`, `importText`, `styleToGraph`, `starterGraph`
- `@xgis/runtime` — `XGISMap` (dynamically imported in blueprint live preview)

### External
None beyond what layouts and components use

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
