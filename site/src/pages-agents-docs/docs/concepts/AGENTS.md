<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# site/src/pages/docs/concepts/

## Purpose
Deep-dive concept guide pages under `/docs/concepts/`. Each page explains a non-trivial architectural or mathematical concept in X-GIS with prose, annotated code blocks, inline SVG diagrams, and (for `compute.astro`) a fully interactive live compiler view. All five pages use the shared `Docs.astro` layout and contribute cards to `src/pages/docs/index.astro`.

## Key Files
| File | Description |
|------|-------------|
| `globe.astro` | "Globe & 3D" — the product-identity concept page (ECEF positioning, the WGS84-ellipsoid-vertex / sphere-camera split and its ~21 km geoid seam, one-source-any-projection, RTC + log depth, per-fragment inverse-Mercator raster drape). Built on the `kit/` primitives + `GlobeDemo` React island; terrain/3D-tiles/streaming/fly-to flagged as ROADMAP. |
| `rtc.astro` | "RTC + DSFUN precision" — explains the LL/MM/DLM/SP coordinate pipeline, why f32 cancellation degrades sub-meter accuracy at high zooms, and how the hi/lo DSFUN split recovers f64-equivalent precision in the vertex shader. References `tile-cross-path-invariants.test.ts` and `docs/COORDINATES.md`. |
| `projections.astro` | "Projection switching" — all eight projections (mercator, equirectangular, natural_earth, orthographic, azimuthal_equidistant, stereographic, oblique_mercator, globe) documented with interactive "Try this →" links to the playground, a WGSL code sample showing the `u.projection_type` uniform path, and a Known Limitations section for polar-cap tile truncation. Imports `SeeAlso.astro` and `SpecLinks.astro`. |
| `pipeline.astro` | "Compile pipeline" — SVG diagram of the Lexer → Parser → AST → `lower()` → IR → `optimize()` → `emit()` / `codegen()` → SceneCommands / ShaderVariants path, with per-stage prose covering constant folding and the four expression classification buckets. |
| `compute.astro` | "Compile graph — live" — the largest page (~2 300 lines): a browser-resident live compiler REPL. Imports `Lexer`, `Parser`, `lower`, `optimize`, `emitCommands` from `@xgis/compiler` directly; shows 9 collapsible stage cards (Tokens → AST → IR Scene → Optimised IR → Paint routing → Palette atlas → Compute plan → Render-node WGSL → Emitted compute kernels), blueprint-style IR card renderer, inline WGSL syntax highlighter, `timestamp-query` GPU micro-benchmark panel, and a static route/strategy quick-reference card. Five built-in presets cover constant-fill, zoom-interpolate, continent `match()`, multi-kind roads, and a 18-arm LUT demo. |

## For AI Agents

### Working In This Directory
- All pages use `<Docs current="concepts/{slug}" ...>` — the `current` prop must include the `concepts/` prefix.
- When adding a new concept page: add a sidebar entry in `src/layouts/Docs.astro` under the "Concepts" group, add a card in `src/pages/docs/index.astro`, and add a search record in `src/lib/search-index.ts`.
- `compute.astro` imports compiler internals via relative path `../../../../../compiler/src/...` (e.g. `paint-routing`, `palette`, `TokenType`) in addition to the `@xgis/compiler` package alias. If compiler source paths change those imports must be updated in tandem.
- `projections.astro` generates `playUrl()` links that branch on `import.meta.env.DEV` to point at `localhost:3000`; ensure the playground demo ID `physical_map` keeps existing when modifying playground examples.
- `compute.astro` uses `<style is:global>` for `.tok-*`, `.stage-*`, `.route-*`, `.strategy-*`, `.bench-*`, `.ir-*`, `.xgis-editor-*`, and `.palette-*` classes. These selectors are page-specific so leakage is benign, but do not duplicate them in a shared stylesheet.
- Concept pages that embed live `XGISMap` instances must use `client:only` for browser-dependent components; `compute.astro` avoids this by importing the compiler directly in a `<script>` block.

### Testing Requirements
- `bun run check` validates TypeScript across the site. Verify concept pages render in `bun dev` before committing.
- The cross-path invariants referenced in `rtc.astro` are gated by `tile-cross-path-invariants.test.ts` in the compiler package — run `bun test` there when touching coordinate-convention prose.
- Projection CPU/GPU consistency assertions referenced in `projections.astro` live in `runtime/src/__tests__/projection-wgsl-consistency.test.ts`.

### Common Patterns
- Annotated code blocks use plain `<pre><code>` inside `bg-bg-card border-line` cards, not expressive-code fences (the docs layout does not bundle EC on these pages).
- Inline SVGs carry `role="img"` and `aria-label` descriptions — preserve both when editing diagrams.
- Mathematical notation is in plain prose; keep exact formulas in code-block comments rather than MathJax/KaTeX.
- The `MATCH_LUT_THRESHOLD = 16` constant in `compiler/src/codegen/compute-gen.ts` is surfaced verbatim in `compute.astro`; keep them in sync.

## Dependencies

### Internal
- `src/layouts/Docs.astro`
- `src/components/SeeAlso.astro` (`projections.astro`)
- `src/components/SpecLinks.astro` (`projections.astro`)
- `@xgis/compiler` — live compile stages in `compute.astro`
- `compiler/src/lexer/tokens` (direct relative import in `compute.astro`)
- `compiler/src/codegen/paint-routing` (direct relative import in `compute.astro`)
- `compiler/src/codegen/palette` (direct relative import in `compute.astro`)

### External
None

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
