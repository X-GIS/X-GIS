<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# site/src/pages/docs/concepts/

## Purpose
Deep-dive concept guide pages under `/docs/concepts/`. Each page explains a non-trivial architectural or mathematical concept in X-GIS with prose, diagrams, and live code embeds. Currently covers three topics: RTC + DSFUN split-precision math, projection switching, and the compile pipeline.

## Key Files
| File | Description |
|------|-------------|
| `rtc.astro` | "RTC + DSFUN precision" — explains why f32 vertices are kept accurate at every camera zoom via the hi/lo split-precision technique in WGSL |
| `projections.astro` | "Projection switching" — seven projections, one source; how the runtime switches via a WGSL uniform without re-tessellating geometry |
| `pipeline.astro` | "Compile pipeline" — Lexer → AST → IR → optimizer → WGSL codegen; the path from a `.xgis` source file to a rendered frame |
| `compute.astro` | WebGPU compute shader concept viewer — live demo of the tile-selector compute path |

## For AI Agents

### Working In This Directory
- These pages use `<Docs current="concepts/{slug}" ...>` — the `current` prop includes the `concepts/` prefix.
- When adding a new concept page: add a sidebar entry in `src/layouts/Docs.astro` under the "Concepts" group, add a card in `src/pages/docs/index.astro`, and add a search record in `src/lib/search-index.ts`.
- Concept pages often embed live `XGISMap` instances. Ensure `@xgis/runtime` is imported server-side only where needed, or use `client:only` for browser-dependent components.

### Testing Requirements
- `bun run check` validates TypeScript. Verify concept pages render and live demos load in `bun dev`.

### Common Patterns
- Heavy on annotated code blocks using the `xgis` and `wgsl` language tags in expressive-code fences.
- Mathematical notation is written in plain prose (no MathJax/KaTeX); keep formulas in code-block comments when precision matters.

## Dependencies

### Internal
- `src/layouts/Docs.astro`
- `@xgis/runtime` — live map embeds
- `@xgis/compiler` — pipeline diagram data

### External
None

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
