<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# playground/src/examples

## Purpose
Raw `.xgis` DSL source files for every demo and fixture in the playground gallery. Each file is the single source of truth for its demo's content; Vite inlines the text at build time via `import.meta.glob('*.xgis', { query: '?raw' })` in `demos.ts`. Files prefixed `fixture-` are minimal isolated examples that exercise one rendering capability (a single triangle, a single point, one keyframe, a specific line join mode, etc.) and are the direct targets of `../e2e/fixtures.spec.ts`. Files prefixed `reftest-` are reference-test pairs used by `../e2e/reftest.spec.ts`. All other files are named-demo examples displayed in the gallery.

## Key Files
| File | Description |
|------|-------------|
| `minimal.xgis` | Smallest valid X-GIS program — single GeoJSON source + one fill layer. The demo runner's default. |
| `fixture-triangle.xgis` | Single triangle polygon; baseline for fill pipeline. |
| `fixture-point.xgis` | Single point feature; baseline for point/SDF pipeline. |
| `fixture-line.xgis` | Single line feature; baseline for SDF line pipeline. |
| `fixture-stroke-fill.xgis` | Polygon with both fill and stroke; tests dual-pass rendering. |
| `fixture-dashed-line.xgis` | Dashed SDF line with a simple dasharray pattern. |
| `fixture-projection-equirectangular.xgis` | Equirectangular projection fixture. |
| `fixture-projection-natural-earth.xgis` | Natural Earth projection fixture. |
| `fixture-projection-orthographic.xgis` | Orthographic projection fixture. |
| `fixture-categorical.xgis` | Per-feature categorical colour expression. |
| `fixture-filter-complex.xgis` | Complex filter expression fixture. |
| `fixture-stress-all-renderers.xgis` | Stress fixture exercising all renderer types simultaneously. |
| `import-mapbox-style.xgis` | Mapbox/MapLibre style import via `import mapbox-style`. |
| `import-maplibre-demo.xgis` | MapLibre demotiles import fixture. |
| `openfreemap-bright.xgis` | Full OFM Bright style via PMTiles (production demo). |
| `pmtiles-labels.xgis` | PMTiles source with label rendering. |
| `osm-style.xgis` | OSM-style vector tile demo. |

## Subdirectories
*(none)*

## For AI Agents

### Working In This Directory
- To add a new fixture: create `fixture-<name>.xgis` here AND add a `DEMOS` entry in `../demos.ts` with `tag: 'fixture'`.
- Fixture `.xgis` files should use only `public/data/` GeoJSON assets or inline data — no external network fetches — so they are deterministic in CI.
- Demo `.xgis` files that reference `pmtiles-proxy/protomaps/v4.pmtiles` are automatically rewritten for production by `demos.ts`; no manual URL management needed.
- Do not add binary files here. All assets are text `.xgis`.

### Testing Requirements
- `../e2e/fixtures.spec.ts` — navigates to `demo.html?id=fixture_<name>` for each `fixture-*` entry and asserts pixel content + zero WebGPU validation errors.
- `../e2e/reftest.spec.ts` — pairs `reftest-*-static.xgis` with `reftest-*-match.xgis` and asserts pixelDiffRatio < threshold.
- `../e2e/smoke.spec.ts` — navigates to a curated subset of 5 demos and asserts no console errors + non-zero canvas pixels.

### Common Patterns
- `.xgis` syntax: top-level blocks are `source { }`, `style { }`, `preset { }`, `symbol { }`, `fn { }`, `background { }`, `layer { }`.
- `source` blocks reference `/data/<file>.geojson` for local GeoJSON or `pmtiles:` URLs for vector tiles.
- Fixture files keep a single source + single layer to isolate the feature under test.

## Dependencies

### Internal
- Loaded by `../demos.ts` via `import.meta.glob`.
- GeoJSON data served from `../../public/data/`.

### External
- PMTiles archives from `demo-bucket.protomaps.com` (via dev proxy) or `api.protomaps.com` (production).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
