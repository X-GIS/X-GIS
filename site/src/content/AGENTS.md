<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# site/src/content/

## Purpose
Typed TypeScript data modules that serve as the single source of truth for structured page content, plus an Astro content collection. The TS modules: `gallery-demos.ts` (the authoritative `Category[]` + `Demo[]` list consumed by `examples.astro` and the search index) and `reference-sections.ts` (the `ReferenceSection[]` list consumed by `reference.astro` and the search index). Keeping data here rather than inline in pages ensures the build-time search index stays consistent with the rendered pages. The `blog/` subdirectory holds the markdown `blog` content collection (schema in `src/content.config.ts`), rendered by `pages/blog/`.

## Key Files
| File | Description |
|------|-------------|
| `gallery-demos.ts` | Exports `Demo` interface, `Category` interface, `galleryCategories: Category[]` (11 categories, ~50 demos), `featuredDemos: Demo[]` (3 entries), and `runIdOf(d)` helper. Each `Demo` carries `id`, optional `runId`, `title`, `body`, and optional `noThumb`, `defaultHash`, `devOnly`, `standaloneUrl`. Thumbnail filename convention: `public/thumbnails/{id}.jpg`. |
| `reference-sections.ts` | Exports `ReferenceSection` interface and `referenceSections: ReferenceSection[]` (12 sections: quick-start → sources → layers → modifiers → filters → match → background → presets → symbols → animation → projections → js-api). Each section carries `id`, `title`, `body`, optional `code` snippet, and optional `demoId`/`demoQuery`/`demoHash` for playground deep-links. |

## For AI Agents

### Working In This Directory
- `gallery-demos.ts` is the ONLY place to add, remove, or rename gallery demos. Do not add demo metadata directly in `examples.astro`.
- The `id` field in each `Demo` entry must match: (1) the playground demo key (or explicit `runId`), and (2) the thumbnail filename `public/thumbnails/{id}.jpg`. `runIdOf(demo)` resolves `runId ?? id.replace(/-/g, '_')`.
- Set `devOnly: true` for demos that depend on the local Vite proxy (e.g., the protomaps v4 daily basemap) — they are hidden in production builds.
- PMTiles demos that get rewritten to the Firenze sample archive in production should carry a `defaultHash` so the user lands at a visible location.
- `standaloneUrl` bypasses `demo.html?id=…` for demos that need bespoke JS glue beyond the declarative `.xgis`-source contract.
- `reference-sections.ts` changes require a corresponding update to the actual prose in `src/pages/docs/reference.astro`.

### Testing Requirements
- TypeScript compilation via `bun run check` validates exported types. There are no runtime unit tests for this directory.

### Common Patterns
- Both files export named array constants; consumers use named imports, not default imports.
- `referenceSections` entries with `demoId` render a "Try this →" playground link; `demoHash` pins the camera to a useful position when the archive is the Firenze sample.

## Dependencies

### Internal
- `src/lib/search-index.ts` — imports both modules to build the build-time search index
- `src/pages/examples.astro` — imports `galleryCategories` and `featuredDemos` from `gallery-demos.ts`
- `src/pages/docs/reference.astro` — imports `referenceSections` from `reference-sections.ts`

### External
None

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
