<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# site/src/components/

## Purpose

Reusable UI components shared across pages and layouts. Covers page furniture (Header, Footer, MobileNav, MobileNavDrawer), home-page marketing sections (WhatIsXGIS, Why, HowItCompiles, BecomesShaders, Capabilities, Coverage, Roadmap, Showcase, RuntimeSupport, QuickStart, Graticule), docs-specific widgets (OnThisPage TOC, PageFeedback, SeeAlso, SpecLinks, Callout), and the client-side Search overlay. Three subdirectories hold non-flat assets: `kit/` (Astro design primitives — see `kit/README.md`), `react/` (React islands), and `ui/` (shadcn-style React primitives).

## Key Files

| File                    | Description                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Header.astro`          | Top navigation bar with logo, desktop nav links, and Search trigger button                                                                                              |
| `Footer.astro`          | Site-wide footer with links and copyright                                                                                                                               |
| `Why.astro`             | "Beyond the library" pillar section on the home page                                                                                                                    |
| `WhatIsXGIS.astro`      | Home-page "what is X-GIS" explainer section                                                                                                                             |
| `HowItCompiles.astro`   | Home-page section illustrating the compile pipeline                                                                                                                     |
| `BecomesShaders.astro`  | Home-page section on style → shader compilation                                                                                                                         |
| `Coverage.astro`        | Home-page spec/feature coverage section                                                                                                                                 |
| `Roadmap.astro`         | Home-page roadmap section                                                                                                                                               |
| `Showcase.astro`        | Home-page showcase/gallery strip                                                                                                                                        |
| `QuickStart.astro`      | Inline install + minimal code sample section on the home page                                                                                                           |
| `Capabilities.astro`    | Home-page capability grid — inline static data, no external import                                                                                                      |
| `Graticule.astro`       | Decorative graticule background used as page chrome                                                                                                                     |
| `MobileNav.astro`       | Mobile navigation trigger button                                                                                                                                        |
| `MobileNavDrawer.astro` | Slide-in mobile navigation drawer                                                                                                                                       |
| `OnThisPage.astro`      | Right-column heading TOC for docs pages; receives `headings` prop                                                                                                       |
| `PageFeedback.astro`    | "Was this page helpful?" widget at the bottom of docs pages                                                                                                             |
| `SeeAlso.astro`         | Related-links card at the bottom of docs pages                                                                                                                          |
| `SpecLinks.astro`       | External spec reference link badges (Mapbox spec, MDN, etc.)                                                                                                            |
| `Callout.astro`         | Styled note/warning/tip admonition block used in docs prose                                                                                                             |
| `RuntimeSupport.astro`  | Inline support-status badge (supported / partial / unsupported)                                                                                                         |
| `Search.astro`          | Client-side fuzzy search overlay; embeds build-time index from `lib/search-index.ts` as inline JSON; parsing is deferred to first ⌘K open to avoid long-task on landing |

## Subdirectories

| Directory | Purpose                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kit/`    | Astro design primitives composed by home/section pages — Card, ContentBand, Eyebrow, FeatureRow, SectionHead, barrel `index.ts` (see `kit/README.md`) |
| `react/`  | React islands hydrated client-side — `Hero.tsx`, `Playground.tsx`, `GlobeDemo.tsx`                                                                    |
| `ui/`     | shadcn-style React primitives — `badge.tsx`, `button.tsx`, `card.tsx`                                                                                 |

## For AI Agents

### Working In This Directory

- Components use the `interface Props` pattern in frontmatter for typed props.
- `Search.astro` embeds the full search index (~27 KB) as an inline `<script type="application/json">` element and parses lazily on first open — keep `src/lib/search-index.ts` accurate.
- `Capabilities.astro` holds its capability data as a static inline array; it does **not** import from `@xgis/compiler`. Update the array directly when capability descriptions change.
- Do not add `client:load` directives unless genuinely needed — prefer static HTML with progressive enhancement via `<script>` tags.
- `Search.astro` keyboard handling covers ⌘K, `/`, Escape, ArrowUp/Down, Enter; maintain all five when modifying the component.

### Testing Requirements

- No component-level unit tests. Verify with `bun run check` (Astro type-check) and visual inspection in dev (`bun run dev` in `site/`).

### Common Patterns

- Tailwind v4 utility classes for all styling; scoped `<style>` blocks only when a CSS feature is unavailable as a utility (e.g. the `search-card` box-shadow and modal display toggling in `Search.astro`).
- `class:list` directive for conditional classes.
- Components that appear in both `Base` and `Docs` layouts own their data inline; they do not accept large data props from layouts.

## Dependencies

### Internal

- `src/lib/search-index.ts` — `Search.astro` calls `buildSearchIndexJSON` at build time

### External

- `tailwindcss` — utility classes throughout all components

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
