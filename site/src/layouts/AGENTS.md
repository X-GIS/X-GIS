<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# site/src/layouts/

## Purpose
Page-level chrome wrappers for the Astro docs site. `Base.astro` is the root HTML shell used by every page: it handles `<head>` metadata (canonical URL, OG/Twitter cards, JSON-LD structured data for SoftwareSourceCode + WebSite), GH Pages base-prefix resolution for assets, and mounts `MobileNavDrawer` at body root. `Docs.astro` extends `Base` with the full docs chrome: a Diátaxis-structured left sidebar nav (7 groups — Overview, Get started, Guides, Language, Reference, Concepts, API), a mobile breadcrumb strip, main content slot, prev/next pagination, `PageFeedback`, "Edit on GitHub" + "Report an issue" footer links with build-time `gitMeta` last-updated stamp, and an `OnThisPage` TOC in the right column (xl+ only, shown only when `headings` is non-empty).

## Key Files
| File | Description |
|------|-------------|
| `Base.astro` | HTML shell: canonical URL + GH Pages `BASE_URL` prefix handling, OG/Twitter meta, JSON-LD (`SoftwareSourceCode` + `WebSite`), `theme-color`, favicon, Geist font comment (self-hosted via `@fontsource-variable/geist`), body with `<slot>` + `MobileNavDrawer` |
| `Docs.astro` | Docs layout: wraps `Base` with sticky desktop sidebar (`navGroups` hard-coded Diátaxis order), mobile breadcrumb nav (group + page label, no horizontal strip), article slot, `PageFeedback`, prev/next pagination derived from flattened `navGroups`, "Edit on GitHub" + "Report an issue" links, `gitMeta` last-updated + contributor count, `OnThisPage` TOC; props: `current` (slug after `/docs/`), `title`, `description`, `headings?` |

## For AI Agents

### Working In This Directory
- `navGroups` in `Docs.astro` is hard-coded (not filesystem-driven). Adding a new docs page requires a matching entry in `navGroups` — otherwise the sidebar and prev/next pagination will skip it.
- The `current` prop must be the exact path segment after `/docs/` (e.g., `'concepts/rtc'`, `'api'`, `''` for the index). It drives sidebar highlight, breadcrumb, prev/next lookup, and the GitHub edit URL.
- The GitHub edit URL is `https://github.com/X-GIS/X-GIS/edit/main/site/src/pages/docs/{current}.astro` (index maps to `index.astro`). It must match the real file path.
- `Base.astro` constructs `base` from `import.meta.env.BASE_URL` (strips trailing slash) to support both GH Pages (`/X-GIS/`) and local dev (`/`) — all asset `href`s and nav `href`s must go through this `base` prefix.
- `MobileNavDrawer` is mounted at body root in `Base.astro` (not inside the header trigger) due to containing-block constraints — do not move it.
- The three-column grid in `Docs.astro` switches between `lg:grid-cols-[220px_1fr]` and `xl:grid-cols-[220px_1fr_200px]` depending on whether `headings` is non-empty; always pass `headings` from `.astro` pages that have sections.

### Testing Requirements
- `bun run check` (Astro type-check) catches prop-type mismatches and missing required props.
- Verify sidebar highlight, mobile breadcrumb, and prev/next links visually in dev (`bun run dev`).
- No vitest unit tests for layout files; correctness is validated through the Playwright e2e suite in `playground/`.

### Common Patterns
- All docs pages: `<Docs current="slug" title="..." description="..." headings={headings}>`.
- Non-docs pages (landing, etc.): `<Base title="...">` with `<Header>` and `<Footer>` composed manually inside the slot.
- Pass `headings={[]}` or omit `headings` to suppress the right-column TOC and collapse to a two-column layout.

## Dependencies

### Internal
- `src/components/Header.astro`, `Footer.astro`, `OnThisPage.astro`, `PageFeedback.astro`, `MobileNavDrawer.astro`
- `src/lib/git-meta.ts` — build-time last-commit date + contributor count shown in the page footer
- `src/styles/global.css` — imported by `Base.astro`

### External
- `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` (self-hosted fonts, referenced in global CSS)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
