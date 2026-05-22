<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# playground/examples

## Purpose
Standalone HTML embedding examples that demonstrate X-GIS usage without the Monaco IDE or Vite dev server. Each file is a self-contained HTML page that can be opened directly in a browser or served from any static file server. They show the minimal boilerplate for embedding an X-GIS map using the `<xgis-map>` custom element or the `XGISMap` imperative API. Useful as reference implementations for documentation and for testing the custom-element registration path independently of the demo runner.

## Key Files
| File | Description |
|------|-------------|
| `shared.css` | Common CSS reset and canvas sizing styles shared by all example HTML files. |
| `minimal.html` | Smallest `<xgis-map>` custom element embedding with a single GeoJSON source. |
| `ocean-land.html` | Ocean + land fill example using natural-earth data. |
| `coastline.html` | Coastline stroke example. |
| `multi-layer.html` | Multiple stacked layers with fill and stroke. |
| `zoom.html` | Zoom-level-dependent style example. |
| `dark.html` | Dark-theme map style. |
| `categorical.html` | Categorical per-feature colour expression. |
| `labels.html` | Text label rendering example. |
| `raster.html` | Raster overlay example. |
| `rivers-lakes.html` | Rivers and lakes with Natural Earth data. |
| `physical-map.html` / `physical-map-50m.html` / `physical-map-10m.html` | Physical terrain map at 110m, 50m, and 10m resolution. |
| `states-provinces.html` / `states-10m.html` | US states and provinces at different resolutions. |
| `vector-categorical.html` | Vector-tile source with categorical styling. |
| `text-overlay.html` | SVG/HTML text overlay on top of the map canvas. |

## Subdirectories
*(none)*

## For AI Agents

### Working In This Directory
- These files reference `../public/data/*.geojson` assets and the built `@xgis/runtime` bundle. They are designed to be served by the Vite dev server (`bun run dev`) but also work as direct file-open examples if the runtime is bundled.
- Do not add Vite-specific syntax (`import.meta.*`, JSX, etc.) — these files are plain HTML with vanilla `<script type="module">`.
- `shared.css` provides `canvas { width: 100%; height: 100vh; display: block; }` — all examples inherit this; do not repeat it.
- When adding a new example, mirror the structure of `minimal.html` and reference the appropriate GeoJSON from `../public/data/`.

### Testing Requirements
- Not directly tested by the Playwright suite. The demo gallery (`src/demos.ts`) is the tested path; these files serve as documentation/embedding reference.

### Common Patterns
- Import pattern: `<script type="module">import { registerXGISElement } from '/@xgis/runtime'</script>` (Vite resolves workspace imports in dev).
- Custom element usage: `<xgis-map src="<inline-xgis-source>"></xgis-map>` or imperative `new XGISMap(canvas, source)`.

## Dependencies

### Internal
- `@xgis/runtime` — `registerXGISElement`, `XGISMap`
- `public/data/*.geojson` — GeoJSON data assets

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
