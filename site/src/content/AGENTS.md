<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# site/src/content/

## Purpose
Typed TypeScript data modules that serve as the single source of truth for structured page content. Two modules live here: the gallery demo list (consumed by `examples.astro` and the search index) and the language-reference section list (consumed by `reference.astro` and the search index). Keeping data here rather than inline in pages ensures the build-time search index stays consistent with the rendered pages.

## Key Files
| File | Description |
|------|-------------|
| `gallery-demos.ts` | Authoritative `Demo[]` list for the `/examples` gallery: `id`, `title`, `body`, optional `runId`, `defaultHash`, `noThumb`, `devOnly`, `standaloneUrl` fields. Thumbnail filename = `public/thumbnails/{id}.jpg`. |
| `reference-sections.ts` | Typed list of language-reference sections used to build the right-side TOC and the search index records for the `/docs/reference` page |

## For AI Agents

### Working In This Directory
- `gallery-demos.ts` is the ONLY place to add, remove, or rename gallery demos. Do not add demo metadata in `examples.astro` directly.
- The `id` field in each `Demo` entry must match: (1) the playground demo key (or explicit `runId`), and (2) the thumbnail filename `public/thumbnails/{id}.jpg`.
- Set `devOnly: true` for demos that depend on the local Vite proxy (e.g., protomaps v4 daily basemap) — they will be hidden in the production build.
- `reference-sections.ts` changes require a corresponding update to the actual content in `src/pages/docs/reference.astro`.

### Testing Requirements
- TypeScript compilation via `bun run check` validates the exported types. No runtime tests.

### Common Patterns
- Both files export a typed array constant. Import with named imports, not default imports.
- `runIdOf(demo)` helper in `gallery-demos.ts` resolves `runId ?? id.replace(/-/g, '_')`.

## Dependencies

### Internal
- `src/lib/search-index.ts` — imports both modules to build the search index
- `src/pages/examples.astro` — imports `gallery-demos.ts`
- `src/pages/docs/reference.astro` — imports `reference-sections.ts`

### External
None

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
