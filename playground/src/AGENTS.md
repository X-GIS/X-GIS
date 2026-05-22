<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# playground/src

## Purpose
TypeScript entry-point modules for the four Vite HTML pages, plus the `.xgis` example/fixture source files that populate the demo gallery. Each `*.ts` module corresponds directly to one HTML page's `<script type="module">` entry; Vite bundles them independently. The `examples/` subdirectory contains the raw `.xgis` DSL files that are inlined at build time via `import.meta.glob`.

## Key Files
| File | Description |
|------|-------------|
| `web-entry.ts` | Thin re-export of `registerXGISElement` and `XGISMap` from `@xgis/runtime`; used by the gallery `index.html` page. |
| `demos.ts` | `DEMOS` registry — maps demo ID strings to `{ name, tag, description, source, picking? }`. Loads `.xgis` source text via `import.meta.glob('*.xgis', { query: '?raw' })`. Handles production URL rewrites for PMTiles sources (dev proxy → protomaps API TileJSON). |
| `gallery.ts` | `TAG_COLORS`/`TAG_LABELS` display maps and explicit `TAG_ORDER` list; builds the category-section DOM for `index.html`. Imports `DEMOS` from `demos.ts`. |
| `demo-runner.ts` | Full interactive demo runner for `demo.html`: Monaco editor with XGIS language support, projection selector, prev/next navigation, mobile editor toggle, Mapbox-import flow (`__xgisImportMapbox`/`__xgisImportSource`), camera hash serialisation, `window.__xgisMap` exposure for e2e tests. |
| `compare-runner.ts` | `compare.html` runner: mounts MapLibre GL JS and X-GIS side by side on the same parsed style, synchronises camera via last-write-wins hash `#z/lat/lon/bearing/pitch`. Style catalogue: MapLibre demotiles, OFM Bright/Liberty/Positron, isolated buildings-only style. |
| `debug-labels.ts` | `debug-labels.html` runner: mobile-facing touch-interactive map with OFM Bright style, on-screen panel showing per-glyph dump (text, anchorX/Y, glyphs with cp/x/y/bearingY/height) via `map.setLabelDumpFilter`/`getDumpedLabels`. Designed for bilingual label vertical-placement debugging on devices without a desktop console. |
| `monaco-xgis.ts` | Monaco editor language registration: XGIS syntax highlighting, theme, inline validation (`validateSource`), and field discovery (`discoverFields`) for autocomplete. |
| `xgis-inspector.ts` | Runtime inspector overlay for picking/hover/click events; renders hit feature name and coordinates in an overlay panel. |
| `earcut.d.ts` | Type declaration shim for earcut (used by playground-side geometry utilities). |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `examples/` | `.xgis` DSL source files for every demo and fixture (see `examples/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- Adding a new demo requires: (1) create `examples/<id>.xgis`, (2) add an entry to `DEMOS` in `demos.ts` with the correct `tag`. The gallery picks it up automatically via the glob.
- `window.__xgisMap` is set by `demo-runner.ts` after map construction. E2e specs depend on this name — do not rename it.
- `window.__xgisReady` is set to `true` by the runtime after first-frame completion. All specs gate on it.
- The camera hash format `#z/lat/lon[/bearing/pitch]` is duplicated in `demo-runner.ts` and `compare-runner.ts`; keep them in sync.
- `PROD_URL_REWRITES` in `demos.ts` uses `import.meta.env.PROD`; never change it to `GITHUB_ACTIONS` (breaks CI playground-audit).

### Testing Requirements
- No unit tests live here. Behaviour is covered by `../e2e/smoke.spec.ts` (per-demo smoke) and `../e2e/fixtures.spec.ts` (per-fixture feature isolation).
- `monaco-xgis.ts` validation is exercised indirectly by `../e2e/_warn-check.spec.ts`.

### Common Patterns
- `demos.ts` uses the `Demo` interface: `{ name, tag, description, source, picking? }`. The `source` field is the raw `.xgis` text (never a URL).
- All four runner modules parse the URL hash for camera state using the same `parseHash`/`formatHash` helpers (copied between files — keep in sync).
- Sprite/glyphs URLs for Mapbox-import flow are stashed in module-scope `pendingSpriteUrl`/`pendingGlyphsUrl` and consumed by `XGISMap` constructor.

## Dependencies

### Internal
- `@xgis/runtime` — `XGISMap`, `registerXGISElement`, `lonLatToMercator`
- `@xgis/compiler` — `convertMapboxStyle` (compare-runner, debug-labels)

### External
- `monaco-editor` (demo-runner.ts, monaco-xgis.ts)
- `maplibre-gl` (compare-runner.ts)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
