<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# site/src/pages/

## Purpose
Route-mapped Astro pages that define the site's URL structure. Top-level pages cover the marketing site (home, examples gallery, blueprint viewer, converter). The `docs/` sub-tree contains the full documentation hierarchy (quickstart, cookbook, language reference, API, concept guides, Mapbox migration/coverage).

## Key Files
| File | Description |
|------|-------------|
| `index.astro` | Home page — composes `Hero`, `Why`, `QuickStart` sections |
| `examples.astro` | Interactive examples gallery — renders cards from `content/gallery-demos.ts` with thumbnails and playground links |
| `convert.astro` | Live `.xgis`-to-Mapbox-style converter; uses cross-origin redirect to the playground in dev, iframe embed in prod |
| `blueprint.astro` | Blueprint visual node editor viewer using `@xgis/blueprint` |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `docs/` | (see `docs/AGENTS.md`) Full docs hierarchy — all `/docs/**` routes |

## For AI Agents

### Working In This Directory
- Every new top-level page must use either `<Base>` (with manual `<Header>`/`<Footer>`) or `<Docs>` as its root layout.
- The `convert.astro` page has a dev/prod branch for the playground URL — do not simplify it; the dev branch handles the SSL cross-origin issue.
- Gallery card thumbnails are loaded from `/thumbnails/{id}.jpg`; the base path prefix is applied automatically by Astro.

### Testing Requirements
- `bun run check` validates props and imports. Verify new pages render correctly in `bun dev`.

### Common Patterns
- `const base = import.meta.env.BASE_URL.replace(/\/+$/, '')` at the top of any page that constructs internal URLs.
- Use `<a href={`${base}/docs/...`}>` not `<a href="/docs/...">` to keep links correct under the `/X-GIS` base path in production.

## Dependencies

### Internal
- `src/layouts/Base.astro`, `src/layouts/Docs.astro`
- `src/components/` — Header, Footer, Hero, Why, QuickStart, etc.
- `src/content/gallery-demos.ts`
- `@xgis/blueprint`, `@xgis/compiler`, `@xgis/runtime`

### External
None beyond what layouts/components use

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
