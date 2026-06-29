<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# playground/src/examples

## Purpose
Raw `.xgis` DSL source files for every demo and fixture in the playground gallery — 127 files total. Each file is the single source of truth for its demo's content; `demos/loader.ts` loads all of them at build time via `import.meta.glob('../examples/*.xgis', { eager: true, query: '?raw', import: 'default' })` and applies a URL rewrite (both dev and prod) for the dead Protomaps PMTiles bucket. Files prefixed `fixture-` are minimal isolated examples that exercise one rendering capability in isolation and are the direct targets of the e2e fixture/reftest specs. Files prefixed `reftest-` form static-vs-match pairs for pixel-diff reftests. All other files are named-demo examples displayed in the gallery.

## Key Files
| File | Description |
|------|-------------|
| `openfreemap-bright.xgis` | Full OFM Bright style via OpenFreeMap TileJSON + NE2 raster shaded relief; the primary production-fidelity demo (~80 layers, fill/stroke/dasharray/interpolate). Symbol layers skipped with inline `// SKIPPED` comments. |
| `osm-style.xgis` | OSM-style vector tile demo via PMTiles source. |
| `import-mapbox-style.xgis` | One-line `import "https://tiles.openfreemap.org/styles/bright"` — exercises the runtime's Mapbox v8 style-URL import path (`convertMapboxStyle`). |
| `pmtiles-source.xgis` | Basic PMTiles source with fill layers; minimal PMTiles path smoke test. |
| `pmtiles-layered.xgis` | Multi-layer PMTiles demo stacking landuse/water/roads. |
| `pmtiles-only-landuse.xgis` | PMTiles filtered to a single source layer (landuse). |
| `pmtiles-protomaps-v4.xgis` | Uses `/pmtiles-proxy/protomaps/v4.pmtiles` — the dev-proxy path that `demos.ts` rewrites to the Protomaps API TileJSON in production. |
| `multiline-labels.xgis` | Exercises `label-max-width`, `label-line-height`, `label-justify`, `label-rotate`, `label-letter-spacing` with inline GeoJSON pushed via `setSourceData`. |
| `picking-demo.xgis` | Country hover/click demo; `picking: true` in DEMOS enables the overlay panel wired by `demo-runner.ts`. |
| `animation-showcase.xgis` | Comprehensive animation demo — keyframe, easing, multi-property. |
| `animation-pulse.xgis` | Pulse animation via opacity/size keyframes on SDF points. |
| `sdf-points.xgis` | SDF point rendering with glow and size expressions. |
| `shape-gallery.xgis` | Gallery of built-in symbol shapes (circle, square, diamond, triangle, etc.). |
| `custom-shapes.xgis` | Custom SVG-path symbol definitions via `symbol { }` blocks. |
| `custom-symbol.xgis` | Single custom symbol layer demo. |
| `megacities.xgis` | World megacities as SDF points with population-driven size expression. |
| `gdp-gradient.xgis` | Country GDP choropleth using `interpolate` color expression. |
| `population-gradient.xgis` | Country population choropleth using `interpolate`. |
| `categorical.xgis` | Per-feature categorical fill using `match` expression. |
| `continent-match.xgis` | Continent-level `match` expression on polygon features. |
| `income-match.xgis` | Country income-group `match` expression. |
| `filter-gdp.xgis` | Filtered layer showing only high-GDP countries. |
| `physical-map.xgis` | Multi-source physical basemap (ocean, land, rivers, shaded relief). |
| `ocean-land.xgis` | Two-layer fill demo (ocean fill + land fill) from Natural Earth GeoJSON. |
| `rivers-lakes.xgis` | Rivers as strokes + lakes as fills from Natural Earth. |
| `coastline.xgis` | Coastline stroke-only layer. |
| `styled-world.xgis` | World countries with styled fill + stroke. |
| `dark.xgis` | Dark-theme basemap style. |
| `raster.xgis` | Raster tile source (OpenStreetMap XYZ) rendered as a `type: raster` layer. |
| `multi-layer.xgis` | Multiple fill layers stacked to demonstrate draw order. |
| `multi-layer-line.xgis` | Multiple stroke layers at different zoom-interpolated widths. |
| `bucket-order.xgis` | Demonstrates explicit layer z-ordering / bucket priority. |
| `line-styles.xgis` | Exercises stroke-cap, stroke-join, dasharray, and miter-limit in one file. |
| `line-offset.xgis` | Stroke offset (left/right) demo. |
| `dashed-lines.xgis` | Various dasharray patterns side by side. |
| `pattern-lines.xgis` | Along-line pattern fill. |
| `translucent-lines.xgis` | Translucent stroke alpha compositing. |
| `stroke-align.xgis` | Stroke-align inset/outset/center comparison. |
| `gradient-points.xgis` | Points with zoom-interpolated fill gradient. |
| `procedural-circles.xgis` | Procedurally placed circle points. |
| `along-path-roads.xgis` | Road labels placed along a path. |
| `fixture-point.xgis` | Single SDF point at (0,0); validates point renderer in isolation. |
| `fixture-line.xgis` | Single line feature; baseline for SDF line pipeline. |
| `fixture-line-join.xgis` | Line with explicit join style. |
| `fixture-triangle.xgis` | Single triangle polygon; baseline for fill pipeline. |
| `fixture-square.xgis` | Single square polygon. |
| `fixture-stroke-fill.xgis` | Polygon with both fill and stroke; tests dual-pass rendering. |
| `fixture-dashed-line.xgis` | Dashed SDF line with simple dasharray. |
| `fixture-translucent-stroke.xgis` | Translucent stroke alpha fixture. |
| `fixture-multi-layer.xgis` | Two-layer scene (fill + stroke) as a minimal multi-layer fixture. |
| `fixture-anim-opacity.xgis` | Opacity keyframe animation fixture. |
| `fixture-anim-color.xgis` | Color keyframe animation fixture. |
| `fixture-anim-ease-linear.xgis` | Linear-easing animation fixture. |
| `fixture-anim-dashoffset.xgis` | Animated dash-offset fixture. |
| `fixture-sdf-point.xgis` | SDF point rendering fixture (fill + halo). |
| `fixture-sdf-glow.xgis` | SDF glow (outer halo) fixture. |
| `fixture-categorical.xgis` | Per-feature categorical colour expression fixture. |
| `fixture-filter-complex.xgis` | Complex boolean filter expression fixture. |
| `fixture-mercator-clip.xgis` | Mercator clip-to-viewport fixture. |
| `fixture-antimeridian.xgis` | Antimeridian-crossing geometry fixture. |
| `fixture-cap-round.xgis` | Round cap line fixture. |
| `fixture-cap-square.xgis` | Square cap line fixture. |
| `fixture-cap-arrow.xgis` | Arrow cap line fixture. |
| `fixture-join-bevel.xgis` | Bevel join fixture. |
| `fixture-join-round.xgis` | Round join fixture. |
| `fixture-miterlimit.xgis` | Miter-limit fixture. |
| `fixture-dasharray-complex.xgis` | Multi-segment dasharray pattern fixture. |
| `fixture-stroke-inset.xgis` | Stroke-align inset fixture. |
| `fixture-stroke-outset.xgis` | Stroke-align outset fixture. |
| `fixture-stroke-offset-right.xgis` | Stroke offset right fixture. |
| `fixture-stroke-offset-right-large.xgis` | Large stroke offset right fixture. |
| `fixture-anchor-center.xgis` | Symbol anchor=center fixture. |
| `fixture-anchor-top.xgis` | Symbol anchor=top fixture. |
| `fixture-anchor-bottom.xgis` | Symbol anchor=bottom fixture. |
| `fixture-flat-anchor-bottom.xgis` | Flat-projection anchor=bottom fixture. |
| `fixture-size-expr.xgis` | Size driven by a property expression fixture. |
| `fixture-size-zoom.xgis` | Zoom-interpolated size expression fixture. |
| `fixture-zoom-opacity.xgis` | Zoom-interpolated opacity fixture. |
| `fixture-shape-custom-svg.xgis` | Custom SVG-path symbol shape fixture. |
| `fixture-pattern-anchor-start.xgis` | Pattern-along-line anchor=start fixture. |
| `fixture-pattern-anchor-end.xgis` | Pattern-along-line anchor=end fixture. |
| `fixture-pattern-units-km.xgis` | Pattern with km-unit spacing fixture. |
| `fixture-pattern-multi.xgis` | Multiple pattern layers fixture. |
| `fixture-inline-push.xgis` | Inline GeoJSON pushed via `setSourceData` after `run()`. |
| `fixture-typed-array-points.xgis` | Typed-array point batch fixture. |
| `fixture-stress-all-renderers.xgis` | Stress fixture exercising fill, stroke, point, and label renderers simultaneously. |
| `fixture-stress-many-layers.xgis` | Stress fixture with a large number of layers. |
| `fixture-projection-equirectangular.xgis` | Equirectangular projection fixture. |
| `fixture-projection-natural-earth.xgis` | Natural Earth projection fixture. |
| `fixture-projection-orthographic.xgis` | Orthographic projection fixture. |
| `fixture-picking.xgis` | Picking fixture — 3 quadrants (kind=a/b/c) assert `pickAt` returns correct featureId. |
| `fixture-x-translucent-anim.xgis` | Cross-property translucent animation fixture. |
| `fixture-x-points-translucent.xgis` | Translucent points cross-fixture. |
| `fixture-x-anim-multi-property.xgis` | Multi-property simultaneous animation fixture. |
| `fixture-x-zoom-time-opacity.xgis` | Combined zoom + time opacity expression fixture. |
| `reftest-triangle-static.xgis` | Reftest pair — static triangle reference frame. |
| `reftest-triangle-match.xgis` | Reftest pair — triangle scene that must pixel-match the static. |
| `reftest-zoom-static.xgis` | Reftest pair — static scene at fixed zoom. |
| `reftest-zoom-degenerate.xgis` | Reftest pair — degenerate zoom case reference. |
| `reftest-stroke-static.xgis` | Reftest pair — static stroke reference. |
| `reftest-stroke-keyframe-static.xgis` | Reftest pair — stroke with keyframe animation reference frame. |

## For AI Agents

### Working In This Directory
- To add a new fixture: create `fixture-<name>.xgis` here AND add an entry to `../demos/fixtures.ts` with `tag: 'fixture'`.
- Fixture `.xgis` files must use only `public/data/` GeoJSON assets or inline source (`type: geojson` with no `url`, data pushed via `setSourceData`) — no external network fetches — so they are deterministic in CI.
- Demo `.xgis` files that reference `/pmtiles-proxy/protomaps/v4.pmtiles` are automatically rewritten (dev and prod) to the protomaps API TileJSON by `demos/loader.ts`; no manual URL management needed.
- `picking-demo.xgis` requires `picking: true` in the DEMOS entry; the overlay panel is wired in `demo-runner.ts`, not in the `.xgis` file.
- The `import "url"` syntax (as in `import-mapbox-style.xgis`) triggers `convertMapboxStyle` in the runtime; the `.xgis` file needs no further layers.
- Do not add binary files here. All assets are text `.xgis`.

### Testing Requirements
- `../e2e/fixtures.spec.ts` — navigates to `demo.html?id=fixture_<name>` for each `fixture-*` entry and asserts pixel content + zero WebGPU validation errors.
- `../e2e/reftest.spec.ts` — pairs `reftest-*-static.xgis` with `reftest-*-match.xgis` (or `reftest-*-degenerate.xgis`) and asserts `pixelDiffRatio` < threshold.
- `../e2e/smoke.spec.ts` — navigates to a curated subset of demos and asserts no console errors + non-zero canvas pixels.
- `../e2e/_fixture-picking.spec.ts` — uses `fixture-picking.xgis`; calls `pickAt` at each quadrant centroid and asserts returned featureId.
- Screenshot/probe outputs land in `../e2e/__*__` dirs (one summary line per dir in the e2e AGENTS.md, not enumerated here).

### Common Patterns
- `.xgis` syntax: top-level blocks are `source { }`, `background { }`, `layer { }`, `symbol { }`, `fn { }`, `preset { }`.
- `source` blocks use `type: geojson` + `url:` for local data, `type: tilejson` + `url:` for TileJSON, or `type: raster` for XYZ raster tiles.
- Layer paint is a pipe-chain: `| fill-red-500 stroke-white stroke-2 opacity-80`.
- Expressions use `interpolate(zoom, z0, v0, z1, v1, ...)`, `match(.prop) { "val" -> color, _ -> fallback }`, and filter syntax `.prop == "val"`.
- Fixture files keep a single source + single layer to isolate the feature under test.

## Dependencies

### Internal
- Loaded by `../demos/loader.ts` via `import.meta.glob('../examples/*.xgis', { eager: true, query: '?raw', import: 'default' })`.
- GeoJSON data served from `../../public/data/`.

### External
- PMTiles archives from `demo-bucket.protomaps.com` (via dev proxy at `/pmtiles-proxy/`) or `api.protomaps.com` (production, API-key-restricted to `x-gis.github.io`).
- OFM TileJSON from `tiles.openfreemap.org`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
