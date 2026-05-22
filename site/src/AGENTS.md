<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# site/src/

## Purpose
All Astro source code for the X-GIS website. Organised into the standard Astro structure: `pages/` (route-mapped `.astro` files), `components/` (shared UI pieces), `layouts/` (page chrome wrappers), `content/` (typed data arrays that feed pages and the search index), `lib/` (build-time utilities), and `styles/` (global CSS).

## Key Files
| File | Description |
|------|-------------|
| *(no top-level files — all in subdirectories)* | |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `pages/` | (see `pages/AGENTS.md`) Route-mapped `.astro` files; top-level marketing + `/docs/**` hierarchy |
| `components/` | (see `components/AGENTS.md`) Reusable Astro UI components (Header, Hero, Footer, Search, etc.) |
| `layouts/` | (see `layouts/AGENTS.md`) `Base.astro` (HTML shell) and `Docs.astro` (docs sidebar + TOC chrome) |
| `content/` | (see `content/AGENTS.md`) Typed TypeScript data: gallery demo list and reference section list |
| `lib/` | (see `lib/AGENTS.md`) Build-time utilities: search index builder, git metadata reader, `.xgis` Shiki grammar |
| `styles/` | (see `styles/AGENTS.md`) `global.css` — Tailwind v4 base + custom design tokens |

## For AI Agents

### Working In This Directory
- Astro components use the `---` frontmatter fence for server-side TypeScript; client-side scripts use `<script>` tags or `client:*` directives.
- Import aliases: use relative imports; no `@/` alias configured.
- Tailwind v4 is configured via the Vite plugin — utility classes are available globally, no `@apply` in component `<style>` blocks needed for layout.

### Testing Requirements
- `bun run check` from `site/` validates all `.astro` files with the Astro TypeScript checker.

### Common Patterns
- Data lives in `content/`; pages import from there. Never duplicate data inline in `.astro` files.
- All docs pages pass `current` to the `Docs` layout to drive the sidebar active state.

## Dependencies

### Internal
- All subdirectories are interdependent; `lib/search-index.ts` imports from `content/`.

### External
- `astro`, `tailwindcss`, `astro-expressive-code`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
