<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# site/src/styles/

## Purpose
Global stylesheet entry point for the X-GIS Astro docs site. `global.css` is the single CSS file for the entire site: it self-hosts the three "Chart Room" typefaces (Big Shoulders Display, Archivo, Spline Sans Mono) via `@fontsource-variable` (avoiding Google Fonts round-trips), imports Tailwind v4, declares all design tokens in a `@theme` block, sets base HTML/body/selection/focus rules in `@layer base`, and defines the page-load / graticule motion keyframes (`fade-up`, `fade-in`, `scale-fade`, `draw-grid`, `marker-pulse`) plus matching `@utility` classes (including the `graticule-field` mesh) with reduced-motion overrides.

## Key Files
| File | Description |
|------|-------------|
| `global.css` | Entire site stylesheet: `@import` for `@fontsource-variable/big-shoulders-display` + `@fontsource-variable/archivo` + `@fontsource-variable/spline-sans-mono` (self-hosted woff2, hash-busted via Vite); `@import "tailwindcss"`; `@theme` block with the Chart Room tokens — `--color-bg/bg-elev/bg-card/bg-hover`, `--color-fg/fg-dim/fg-mute/fg-faint`, `--color-line/line-strong`, `--color-graticule/graticule-strong`, `--color-accent/accent-hover/accent-press` (phosphor cyan), `--color-vermilion/vermilion-dim` (signature) and 3 font-stack tokens (`--font-display`, `--font-sans`, `--font-mono`); `@layer base` applying fonts, antialiasing, scroll-behavior, `::selection` (cyan on ink), `:focus-visible` ring, tabular numerals; `@keyframes` + `@utility` for `fade-up`, `fade-in`, `scale-fade`, `draw-grid`, `marker-pulse`, and the `graticule-field` mesh; `prefers-reduced-motion` block disabling them. |

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
- "Chart Room" dark palette (nautical/topographic chart on a screen): ink `#0b1722` ground, bone `#eae6da` text, phosphor-cyan accent `#45dbd2` (the workhorse — links/buttons/focus), surveyor-vermilion `#ff5a36` (signature only — projection marker + legend ticks). The graticule mesh (`--color-graticule`) backs the page as its structural grid.
- Big Shoulders Display Variable is the DISPLAY face (page titles + big section heads, always uppercase — the chart title-block look); Archivo Variable is the body sans; Spline Sans Mono Variable is the code/label/coordinate face. Reference as `"Big Shoulders Display Variable"` / `"Archivo Variable"` / `"Spline Sans Mono Variable"` in the font stacks. Micro-labels (eyebrows, legends, table headers) use `font-mono uppercase tracking-[0.16em]`.
- Page-load motion: `fade-up` (28 px translate + opacity, 1.1 s), `fade-in` (opacity only, 1.4 s), `scale-fade` (scale 0.96→1 + opacity, 1.4 s). All use Apple-easing `cubic-bezier(0.16, 0.84, 0.32, 1)` or `ease-out`.

## Dependencies

### Internal
- Imported by `site/src/layouts/Base.astro` (single import point for the whole site)

### External
- `tailwindcss` ^4 (Vite plugin scans Astro/HTML for utility usage)
- `@fontsource-variable/big-shoulders-display` (display face, self-hosted woff2)
- `@fontsource-variable/archivo` (body sans, self-hosted woff2)
- `@fontsource-variable/spline-sans-mono` (mono — code/labels, self-hosted woff2)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
