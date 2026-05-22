<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# site/src/styles/

## Purpose
Global stylesheet entry point for the X-GIS site. `global.css` imports Tailwind v4's base layer and defines the site's design tokens as CSS custom properties (color palette, typography scale, spacing). Imported once in `Base.astro`; the Tailwind v4 Vite plugin scans all Astro/HTML files for utility usage.

## Key Files
| File | Description |
|------|-------------|
| `global.css` | Tailwind v4 base import + CSS custom properties for the design system (accent, fg, fg-dim, fg-mute, bg-card, bg-hover, line, line-strong, etc.) |

## For AI Agents

### Working In This Directory
- Design tokens are defined as CSS custom properties here. Use `var(--token-name)` in components rather than hard-coding hex values.
- Tailwind v4 does not use a `tailwind.config.*` file; configuration (theme extensions, custom utilities) is done in this CSS file via `@theme` blocks.
- Do not add per-component CSS files; use Tailwind utilities in the component markup instead.

### Testing Requirements
- No automated tests. Verify visually in dev.

### Common Patterns
- Dark-surface design: `--bg` is a dark neutral, `--accent` is the brand highlight used for links and CTAs.
- All color references in components use the token names (e.g., `text-accent`, `bg-bg-card`) which map to the CSS custom properties defined here.

## Dependencies

### Internal
- Imported by `src/layouts/Base.astro`

### External
- `tailwindcss` ^4

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
