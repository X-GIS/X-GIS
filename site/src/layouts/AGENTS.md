<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# site/src/layouts/

## Purpose
Page-level chrome wrappers used by all site pages. `Base.astro` provides the HTML shell (doctype, `<head>` with fonts + global CSS, body wrapper). `Docs.astro` extends `Base` with the docs-specific three-column layout: left sidebar navigation, main content slot, and right-column On-this-page TOC. `Docs.astro` also renders the "Edit this page on GitHub" link and the `PageFeedback` widget.

## Key Files
| File | Description |
|------|-------------|
| `Base.astro` | HTML shell: `<head>` meta, Geist/Geist Mono fonts, `global.css`, body wrapper with slot |
| `Docs.astro` | Docs layout: `Base` + left sidebar nav (all docs sections) + `OnThisPage` TOC + `PageFeedback`; accepts `current`, `title`, `description`, `headings` props; generates GitHub edit link from `lib/git-meta.ts` |

## For AI Agents

### Working In This Directory
- `Docs.astro` `current` prop is the path segment after `/docs/` (e.g., `'reference'`, `'concepts/rtc'`, `''` for the index). Use it exactly — the sidebar highlights the matching entry.
- The sidebar nav list in `Docs.astro` is hard-coded (not generated from the filesystem). When adding a new docs page, also add its entry to the sidebar in `Docs.astro`.
- The GitHub edit URL is constructed as `https://github.com/X-GIS/X-GIS/edit/main/site/src/pages/docs/{current}` — it must match the actual file path.
- `Base.astro` includes the Geist variable font via `@fontsource-variable/geist`; do not add additional font imports without removing one.

### Testing Requirements
- `bun run check` catches prop-type mismatches. Verify sidebar highlight and TOC rendering visually in dev.

### Common Patterns
- All docs `.astro` pages use `<Docs current="..." title="..." description="...">` as their root wrapper.
- Non-docs pages use `<Base>` directly with `<Header>` and `<Footer>` composed manually (see `src/pages/index.astro`).

## Dependencies

### Internal
- `src/components/Header.astro`, `Footer.astro`, `OnThisPage.astro`, `PageFeedback.astro`
- `src/lib/git-meta.ts` — last-commit date shown on docs pages

### External
- `@fontsource-variable/geist`, `@fontsource-variable/geist-mono`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
