<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# playground/examples

## Purpose
Standalone HTML embedding examples that demonstrate X-GIS usage in a plain browser context, outside the Monaco IDE and Vite playground app. Each file is a self-contained page that imports `XGISMap` from `@xgis/runtime`, renders an inline `.xgis` source program via `map.run()`, and loads GeoJSON assets from `../data/`. They serve as minimal-boilerplate reference implementations for documentation authors and as an independent test of the imperative `XGISMap` API path (distinct from the custom-element path exercised by the demo runner).

## Key Files
| File | Description |
|------|-------------|
| `shared.css` | Full UI chrome for all example pages: canvas full-viewport, fixed topbar with breadcrumb + title + desc, collapsible `#source-panel` showing the `.xgis` program, `#status` badge, and `#error` overlay. All examples link this; do not duplicate its rules. |
| `minimal.html` | Smallest complete example — one GeoJSON source (`countries.geojson`), one fill+stroke layer, `map.showInspector()`. Canonical template for new examples. |
| `ocean-land.html` | Ocean background + land fill using natural-earth data. |
| `coastline.html` | Coastline stroke-only example. |
| `multi-layer.html` | Multiple stacked fill and stroke layers from a single source. |
| `zoom.html` | Style with zoom-level-dependent layer visibility or paint properties. |
| `dark.html` | Dark-theme map style. |
| `categorical.html` | Per-feature categorical colour expression. |
| `labels.html` | Text label rendering via `label-["{.name}"]` template with inline GeoJSON pushed via `map.setSourceData()` after `map.run()` resolves. |
| `raster.html` | Raster overlay source and layer example. |
| `rivers-lakes.html` | Rivers and lakes rendered from natural-earth GeoJSON data. |
| `physical-map.html` | Physical terrain map at 110 m resolution. |
| `physical-map-50m.html` | Physical terrain map at 50 m resolution. |
| `physical-map-10m.html` | Physical terrain map at 10 m resolution. |
| `states-provinces.html` | US states and Canadian provinces. |
| `states-10m.html` | US states at 10 m resolution. |
| `vector-categorical.html` | Vector-tile source with categorical per-feature styling. |
| `text-overlay.html` | SVG/HTML text overlay positioned on top of the map canvas. |

## For AI Agents

### Working In This Directory
- The actual runtime import is `import { XGISMap } from '@xgis/runtime'`; there is no `registerXGISElement` call in any current example. Vite resolves the workspace package in dev.
- The standard bootstrap is: `new XGISMap(canvas)` → `map.showInspector()` → `map.run(srcString, '../data/')`. `map.run()` returns a Promise; always attach `.catch()` to show the `#error` overlay.
- For inline GeoJSON sources (no `url:` in the `.xgis` program), call `map.setSourceData(sourceName, featureCollection)` inside the `.then()` callback after `map.run()` resolves — not before.
- Do not add Vite-specific syntax (`import.meta.*`, JSX) — these are plain HTML with `<script type="module">`.
- `shared.css` provides the topbar, source-panel, status badge, and error overlay chrome. Mirror the `#topbar`, `#source-panel`, `#status`, and `#error` `<div>` structure from `minimal.html` exactly when adding a new page.
- GeoJSON assets live in `../data/` (i.e., `playground/public/data/`). Reference them as relative paths in `url:` directives.

### Testing Requirements
- These files are not covered by the Playwright e2e suite directly. The Playwright-tested path goes through the demo gallery (`playground/src/demos.ts`). These pages are documentation/embedding references and exercise `XGISMap` independently of the demo runner.
- Smoke-test a new example by opening it via `bun run dev` and confirming the map renders without console errors.

### Common Patterns
- Minimal `.xgis` program structure embedded in a `<pre id="source-code">` element, passed to `map.run()` as text content.
- Topbar breadcrumb: `&larr; Examples` link to `../` + `.title` + `.desc` span (hidden on mobile via `@media (max-width: 640px)`).
- `physical-map-*.html` trio demonstrates multi-resolution variants of the same style — copy the pattern when adding resolution variants.

## Dependencies

### Internal
- `@xgis/runtime` — `XGISMap` (imperative API: `run`, `setSourceData`, `showInspector`)
- `../data/*.geojson` — GeoJSON data assets served from `playground/public/data/`

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
