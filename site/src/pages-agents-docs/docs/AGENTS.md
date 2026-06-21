<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# site/src/pages/docs/

## Purpose
Documentation pages for the X-GIS language and runtime. Each `.astro` file maps to a `/docs/{name}` URL. Covers the getting-started path (quickstart, cookbook, Mapbox migration, Mapbox spec coverage), the language reference (reference, sources, functions, expressions, utilities, glossary, API), and concept deep-dives in `concepts/`. The index page (`index.astro`) renders the card grid linking to all sections.

## Key Files
| File | Description |
|------|-------------|
| `index.astro` | Docs landing page — card grid linking every docs sub-page, with a link to the playground quickstart |
| `quickstart.astro` | Five-minute tutorial: install, declare source + layer, mount on canvas |
| `cookbook.astro` | Copy-paste recipes — 3D buildings, categorical fill, zoom-fade, road casing, animation |
| `reference.astro` | Complete language reference — every block, statement, and modifier with working code samples |
| `sources.astro` | Source-type reference — GeoJSON, PMTiles, TileJSON, raster XYZ |
| `functions.astro` | Built-in function reference — clamp, interpolate, trig, circle/arc/polygon, zoom, constants |
| `expressions.astro` | Operator precedence and the four expression idioms (bracket binding, match, filter, field modifier) |
| `utilities.astro` | Tailwind-style utility class catalog — colors, fills, strokes, opacity, modifiers |
| `glossary.astro` | Glossary of X-GIS and cartographic terms |
| `api.astro` | JavaScript API reference — XGISMap, Camera, projections, loaders from `@xgis/runtime`; inlines typed `ApiEntry` structs with per-parameter tables |
| `mapbox.astro` | Mapbox GL JS -> X-GIS migration guide: conceptual differences + expression mapping |
| `mapbox-spec.astro` | Auto-validated Mapbox Style Spec coverage matrix (supported / partial / unsupported) from `@xgis/compiler` spec-coverage data |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `concepts/` | Deep-dive concept guides: RTC precision, projections, compile pipeline, blueprint/compute (see `concepts/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- All pages use `<Docs current="..." title="..." description="...">` as root; `current` must match the path segment after `/docs/` exactly or the sidebar highlight breaks.
- When adding a new docs page: (1) create the `.astro` file, (2) add a sidebar entry in `src/layouts/Docs.astro`, (3) add a card to `index.astro`, (4) add a `SearchRecord` in `src/lib/search-index.ts`.
- `mapbox-spec.astro` imports from `@xgis/compiler`'s `spec-coverage` module — spec coverage data updates automatically propagate at build time; do not inline the matrix manually.
- `api.astro` defines local `ApiEntry`/`ApiParam`/`ApiReturn`/`ApiSee` interfaces and renders them; changes to the public runtime API require updating those data arrays here.

### Testing Requirements
- `bun run check` validates TypeScript across all pages. Confirm the `current` prop in each page matches its sidebar entry in `Docs.astro`.
- No vitest unit tests in this directory; correctness is validated at build + visual review time.

### Common Patterns
- Code samples use `astro-expressive-code` fenced blocks with the `xgis` language tag for `.xgis` snippets.
- Pages rendering structured data (spec matrix, API reference) import typed data from `@xgis/compiler` or local interfaces rather than inlining raw arrays.

## Dependencies

### Internal
- `src/layouts/Docs.astro` — shared sidebar + page shell
- `src/lib/search-index.ts` — add a `SearchRecord` for every new page
- `@xgis/compiler` — `mapbox-spec.astro` reads spec-coverage; `api.astro` may reference runtime types

### External
None beyond Astro + Tailwind

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
