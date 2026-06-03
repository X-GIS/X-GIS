<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# site/src/styles/

## Purpose
Global stylesheet entry point for the X-GIS Astro docs site. `global.css` is the single CSS file for the entire site: it self-hosts the Geist variable font family (avoiding Google Fonts round-trips), imports Tailwind v4, declares all design tokens in a `@theme` block, sets base HTML/body/selection/focus rules in `@layer base`, and defines three page-load animation keyframes (`fade-up`, `fade-in`, `scale-fade`) plus matching `@utility` classes with reduced-motion overrides.

## Key Files
| File | Description |
|------|-------------|
| `global.css` | Entire site stylesheet: `@import` for `@fontsource-variable/geist` + `@fontsource-variable/geist-mono` (self-hosted woff2, hash-busted via Vite); `@import "tailwindcss"`; `@theme` block with 13 color tokens (`--color-bg/bg-elev/bg-card/bg-hover`, `--color-fg/fg-dim/fg-mute/fg-faint`, `--color-line/line-strong`, `--color-accent/accent-hover/accent-press`) and 2 font-stack tokens (`--font-sans`, `--font-mono`); `@layer base` applying fonts, antialiasing, scroll-behavior, `::selection` (accent blue), Apple-style `:focus-visible` ring, tabular numerals; `@keyframes` + `@utility` for `fade-up`, `fade-in`, `scale-fade`; `prefers-reduced-motion` block disabling all three. |

## For AI Agents

### Working In This Directory
- All color references in components must use `var(--color-*)` tokens (e.g. `text-[var(--color-accent)]` or Tailwind utility aliases like `bg-bg-card`). Never hard-code hex values in components.
- Tailwind v4 uses `@theme` for token/extension configuration — there is no `tailwind.config.*` file. Add new design tokens here as `--color-*` or `--font-*` custom properties inside the `@theme` block.
- Font imports are `@fontsource-variable` packages (not Google Fonts CDN). If swapping fonts, update both the `@import` lines and the `--font-sans`/`--font-mono` `@theme` values.
- Do not add per-component `.css` files; use Tailwind utilities in component markup. This file is the only CSS authored in the project.
- Animation utilities (`fade-up`, `fade-in`, `scale-fade`) are declared as `@utility` so Tailwind scans them. Apply via class name in markup; they self-disable under `prefers-reduced-motion`.

### Testing Requirements
- No automated tests. Verify visually via `bun run dev` in `site/`. Check token propagation, font loading (no FOUT), focus ring on keyboard nav, and animation behaviour with OS reduced-motion toggled.

### Common Patterns
- Apple Developer–style dark palette: true-black `#000000` ground, paper-white `#f5f5f7` text, single iOS-blue accent `#2997ff`. No secondary accents; no gradients except a single hero radial defined in a component.
- Geist Variable is the primary sans-serif; Geist Mono Variable for code. Both registered via `@font-face` by the fontsource packages — reference as `"Geist Variable"` / `"Geist Mono Variable"` in the font stacks.
- Page-load motion: `fade-up` (28 px translate + opacity, 1.1 s), `fade-in` (opacity only, 1.4 s), `scale-fade` (scale 0.96→1 + opacity, 1.4 s). All use Apple-easing `cubic-bezier(0.16, 0.84, 0.32, 1)` or `ease-out`.

## Dependencies

### Internal
- Imported by `site/src/layouts/Base.astro` (single import point for the whole site)

### External
- `tailwindcss` ^4 (Vite plugin scans Astro/HTML for utility usage)
- `@fontsource-variable/geist` (Geist sans variable font, self-hosted woff2)
- `@fontsource-variable/geist-mono` (Geist Mono variable font, self-hosted woff2)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
