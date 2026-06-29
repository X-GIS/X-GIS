<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# site/src/styles/

## Purpose
Global stylesheet entry point for the X-GIS Astro docs site. `global.css` is the single CSS file for the entire site: it self-hosts Inter + Geist Mono via `@fontsource-variable` (avoiding Google Fonts round-trips), imports Tailwind v4 and `tw-animate-css`, declares all design tokens in a `@theme` block, sets base HTML/body/selection/focus rules in `@layer base`, and defines the page-load / graticule motion keyframes plus matching `@utility` classes with reduced-motion overrides. The palette is the "xAI" monochrome system — near-black ground, white text, white as the accent (emphasis carried by shape + weight, not hue).

## Key Files
| File | Description |
|------|-------------|
| `global.css` | Entire site stylesheet: `@import` for `@fontsource-variable/inter` + `@fontsource-variable/geist-mono` (self-hosted woff2, hash-busted via Vite); `@import "tailwindcss"`; `@import "tw-animate-css"`; `@theme` block with two token layers — (1) a shadcn-style set (`--color-background/foreground/card/primary/secondary/muted/destructive/border/input/ring …`) and (2) the X-GIS utility aliases (`--color-bg/bg-elev/bg-card/bg-hover`, `--color-fg/fg-dim/fg-mute/fg-faint`, `--color-line/line-strong`, `--color-graticule/graticule-strong`, `--color-accent/accent-hover/accent-press` → `--sienna` which is **white** in this theme, `--color-vermilion/vermilion-dim`), plus 3 font-stack tokens (`--font-display`, `--font-sans` = Inter, `--font-mono` = Geist Mono); `@layer base` applying fonts, antialiasing, scroll-behavior, `::selection`, `:focus-visible` ring, tabular numerals; `@keyframes` + `@utility` for the page-load + graticule-mesh motion; `prefers-reduced-motion` block disabling them. |

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
- "xAI" monochrome palette: near-black ink `#0a0a0a` ground, white `#ffffff` text, accent `--sienna` is **white** (`--color-accent`) — the brand is white-on-near-black, so emphasis is carried by shape (pill) + weight, NOT hue. A solid hairline (`--hair` `#212327`, `--color-line`) is the elevation device; the graticule mesh (`--color-graticule`) backs the page as its structural grid.
- Inter Variable is both the display and body face (`--font-display` = `--font-sans`); Geist Mono Variable is the code/label/coordinate face (`--font-mono`). Reference as `"Inter Variable"` / `"Geist Mono Variable"` in the font stacks. Micro-labels (eyebrows, legends, table headers) use `font-mono uppercase` tracking (see `kit/Eyebrow`).
- A shadcn-style token set (`--color-primary`, `--color-muted`, `--color-border`, …) coexists with the X-GIS utility aliases so the `ui/` React primitives (badge/button/card) and the Astro components share one `@theme`.

## Dependencies

### Internal
- Imported by `site/src/layouts/Base.astro` (single import point for the whole site)

### External
- `tailwindcss` ^4 (Vite plugin scans Astro/HTML for utility usage)
- `tw-animate-css` (animation utilities, imported after Tailwind)
- `@fontsource-variable/inter` (display + body face, self-hosted woff2)
- `@fontsource-variable/geist-mono` (mono — code/labels, self-hosted woff2)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
