<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# site/src/components/

## Purpose
Reusable Astro UI components shared across pages and layouts. Covers the full page furniture (Header, Footer, MobileNav), marketing-page sections (Hero, Why, QuickStart, Stats), docs-specific widgets (OnThisPage TOC, PageFeedback, SeeAlso, SpecLinks, Callout, RuntimeSupport, Capabilities), and the client-side Search overlay.

## Key Files
| File | Description |
|------|-------------|
| `Header.astro` | Top navigation bar with logo, desktop nav links, and Search trigger |
| `Footer.astro` | Site-wide footer with links and copyright |
| `Hero.astro` | Home-page hero section — headline, sub-copy, CTA buttons |
| `Why.astro` | "Beyond the library" four-pillar section on the home page |
| `QuickStart.astro` | Inline install + minimal code sample section on the home page |
| `MobileNav.astro` | Mobile navigation trigger button |
| `MobileNavDrawer.astro` | Slide-in mobile navigation drawer |
| `OnThisPage.astro` | Right-column heading TOC for docs pages; receives `headings` prop |
| `PageFeedback.astro` | "Was this page helpful?" widget at the bottom of docs pages |
| `SeeAlso.astro` | Related-links card at the bottom of docs pages |
| `SpecLinks.astro` | External spec reference link badges (Mapbox spec, MDN, etc.) |
| `Callout.astro` | Styled note/warning/tip admonition block used in docs prose |
| `RuntimeSupport.astro` | Inline support-status badge (supported / partial / unsupported) |
| `Capabilities.astro` | Renders the Mapbox spec coverage table from `@xgis/compiler` spec-coverage data |
| `Search.astro` | Client-side fuzzy search overlay; embeds the build-time index from `lib/search-index.ts` as JSON |
| `Stats.astro` | Numeric stats card (currently unused on the home page) |

## For AI Agents

### Working In This Directory
- Components receive typed props via the `interface Props` pattern in their frontmatter.
- The `Search` component embeds the full search index as a JSON literal at build time — keep `lib/search-index.ts` accurate so search results stay correct.
- `Capabilities.astro` imports directly from `@xgis/compiler`; if spec-coverage data changes shape, update this component.
- Do not add `client:load` directives unless genuinely needed — prefer static HTML with progressive enhancement via `<script>` tags.

### Testing Requirements
- No component-level unit tests. Verify with `bun run check` and visual inspection in dev.

### Common Patterns
- Tailwind v4 utility classes for all styling; no component-scoped `<style>` blocks unless a CSS feature is unavailable as a utility.
- `class:list` directive for conditional classes.
- Components that appear in both `Base` and `Docs` layouts import their own data; they do not accept large data props.

## Dependencies

### Internal
- `src/lib/search-index.ts` — `Search.astro` embeds the index
- `@xgis/compiler` — `Capabilities.astro` reads spec-coverage data

### External
- `tailwindcss` — utility classes

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
