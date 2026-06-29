<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# playground/src

## Purpose
TypeScript entry-point modules for the four Vite HTML pages (`index.html`, `demo.html`, `compare.html`, `debug-labels.html`) plus the `.xgis` example/fixture source files that populate the demo gallery. Each `*.ts` module corresponds directly to one HTML page's `<script type="module">` entry; Vite bundles them independently. The `examples/` subdirectory contains the raw `.xgis` DSL files that are inlined at build time via `import.meta.glob`.

## Key Files
| File | Description |
|------|-------------|
| `web-entry.ts` | Thin re-export of `registerXGISElement` and `XGISMap` from `@xgis/runtime`; used by the gallery `index.html` page. |
| `demos.ts` | `DEMOS` registry assembler — spreads per-category fragments (`demos/core.ts`, `style.ts`, `natural-earth.ts`, `data-driven.ts`, `procedural.ts`, `lines.ts`, `detail-10m.ts`, `thematic.ts`, `fixtures.ts`) into one insertion-ordered `Record<string, Demo>` (~127 entries). Each fragment is a pure `Record<string, Demo>` keyed by stable demo ids. The `.xgis` `?raw` glob, the `Demo` type, and the `URL_REWRITES` table live in `demos/loader.ts`. |
| `demos/loader.ts` | Shared demo loader: `import.meta.glob('../examples/*.xgis', { eager:true, query:'?raw', import:'default' })` + `load(file)` applies `URL_REWRITES` in BOTH dev and prod (the old protomaps demo-bucket path is dead/404, so `/pmtiles-proxy/protomaps/v4.pmtiles` → `api.protomaps.com/tiles/v4.json` keyed request, CORS-exempt from localhost and allowed for `x-gis.github.io` in prod). Defines the `Demo` interface (`name`, `tag`, `description`, `source`, `picking?`). |
| `gallery.ts` | `TAG_COLORS` / `TAG_LABELS` / `TAG_ORDER` display maps; builds category-section DOM for `index.html` with inline search filtering. Imports `DEMOS` from `demos.ts`. |
| `demo-runner.ts` | Full interactive demo runner for `demo.html`: Monaco editor with XGIS language support, projection selector, prev/next navigation, snapshot copy button (`__xgisSnapshot`), mobile editor toggle, in-page log overlay (captures `console.error`/`console.warn`/uncaptured WebGPU errors), `?debug=labels` label-anchor visualiser overlay, `?profile=1` inspector activation, `?safe=1` MSAA bypass toggle, Mapbox-import flow (`__xgisImportMapbox` / sessionStorage `__xgisImportSource`), camera hash serialisation (`#z/lat/lon/bearing/pitch`), and `window.__xgisMap` / `window.__xgisReady` exposure for e2e tests. |
| `mapbox-projection.ts` | Extracts host-applicable Mapbox style-spec fields (`projection` type name and `light` block) for use by `demo-runner.ts` and `compare-runner.ts`; provides `extractMapboxProjectionName` and `extractMapboxLight` utilities with CSS colour parsing. |
| `compare-runner.ts` | `compare.html` runner: mounts MapLibre GL JS and X-GIS side-by-side on the same parsed `style.json` (X-GIS via `convertMapboxStyle`), synchronises camera via last-write-wins rAF poll and `history.replaceState`. Style catalogue: MapLibre demotiles, OFM Bright/Liberty/Positron, isolated buildings-only style. |
| `debug-labels.ts` | `debug-labels.html` runner: single touch-interactive OFM Bright map with per-glyph placement dump panel (`map.setLabelDumpFilter` / `getDumpedLabels`). Renders intra-line monotonicity, render-Y spread, rfs-mixing, and cross-line overlap diagnostics (Korean/CJK label debugging). Includes icon-dump pairing for shield text-vs-box alignment check. |
| `monaco-xgis.ts` | Monaco language registration: Monarch tokenizer, bracket/comment config, completion provider (field access, utility pipe, Tailwind color/shape completions, source/layer snippet templates, GeoJSON+PMTiles per-source-layer `discoverFields`), go-to-definition, document symbols outline, hover docs, and `validateSource` (real-time Lexer+Parser errors with line/col markers). |
| `xgis-inspector.ts` | `?profile=1` runtime inspector overlay: six tabs (Frame/Tiles/GPU/Cache/Camera/Net) updating at 4 Hz via rAF ring buffer. Monkey-patches `hasTileData`, `acquireBuffer`, `doUploadTile`, `loadTile`, `cancelStale` for hit/miss telemetry without modifying production code. Activated lazily via dynamic `import('./xgis-inspector')`. |
| `earcut.d.ts` | Type declaration shim for earcut (used by playground-side geometry utilities). |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `examples/` | `.xgis` DSL source files for every demo and fixture (see `examples/AGENTS.md`). |
| `demos/` | Per-category `DEMOS` fragments (`core`, `style`, `natural-earth`, `data-driven`, `procedural`, `lines`, `detail-10m`, `thematic`, `fixtures`) plus the shared `loader.ts` (`?raw` glob, `URL_REWRITES`, `Demo` type). Assembled by `demos.ts`. |

## For AI Agents

### Working In This Directory
- Adding a new demo requires: (1) create `examples/<id>.xgis`, (2) add an entry to the matching `demos/<category>.ts` fragment with the correct `tag` (NOT inline in `demos.ts`, which only spreads fragments). The gallery and dropdown pick it up automatically via the glob.
- `window.__xgisMap` is set by `demo-runner.ts` after map construction; `window.__xgisReady` is set by the runtime after first-frame completion. E2e specs gate on both — do not rename either.
- The camera hash format `#z/lat/lon[/bearing/pitch]` is duplicated in `demo-runner.ts` and `compare-runner.ts`; keep them in sync (the comment in `compare-runner.ts:31` calls this out explicitly).
- `URL_REWRITES` in `demos/loader.ts` is applied in BOTH dev and prod (the protomaps demo bucket is dead/404, so the rewrite to `api.protomaps.com/tiles/v4.json` is needed everywhere). The API key is CORS-exempt from localhost and allowed for `x-gis.github.io` in the protomaps dashboard.
- Demos with `picking: true` trigger `setupPickingOverlay` in `demo-runner.ts`, which calls `setQuality({ picking: true })` programmatically — no URL param needed.
- `applyFixtureAutoPush` in `demo-runner.ts` auto-pushes sample data for `fixture_inline_push`, `multiline_labels`, and `fixture_typed_array_points` when `?e2e=1` is absent. E2e tests pass `?e2e=1` to control push cadence themselves.
- `xgis-inspector.ts` is loaded dynamically (`?profile=1`); it monkey-patches renderer internals after a 1-second delay to allow construction. If the map isn't ready at 1 s it retries at 1.5 s.
- `pendingSpriteUrl` / `pendingGlyphsUrl` in `demo-runner.ts` are module-scope vars that must be set BEFORE `runSource` is called, so the `XGISMap` constructor seeds the `IconStage` gate. Setting them after `run()` is a no-op (iter 105 bug).

### Testing Requirements
- No unit tests live here. Behaviour is covered by `../e2e/smoke.spec.ts` (per-demo smoke) and `../e2e/fixtures.spec.ts` (per-fixture feature isolation).
- `monaco-xgis.ts` validation is exercised indirectly by `../e2e/_warn-check.spec.ts`.
- The `__*__` screenshot/probe output dirs under `../e2e/` are generated artifacts — one summary line per run, not enumerated.

### Common Patterns
- The `Demo` interface (`{ name, tag, description, source, picking? }`) is defined in `demos/loader.ts`. The `source` field is the raw `.xgis` text (never a URL).
- `parseHash` / `formatHash` helpers are inlined in both `demo-runner.ts` and `compare-runner.ts` — keep them in sync on any hash-format change.
- Sprite/glyphs URLs for the Mapbox-import flow are stashed in module-scope `pendingSpriteUrl` / `pendingGlyphsUrl` and consumed by the `XGISMap` constructor inside `runSource`.
- `?compute=1` opt-in threads through `XGISMap({ enableComputePath: true })` and bypasses `convertMapboxStyle`'s match-expander in `compare-runner.ts`.

## Dependencies

### Internal
- `@xgis/runtime` — `XGISMap`, `registerXGISElement`, `lonLatToMercator`, `fetchPMTilesVectorLayerSchema`
- `@xgis/compiler` — `convertMapboxStyle`, `Lexer`, `Parser`, `tileKeyUnpack`

### External
- `monaco-editor` (`demo-runner.ts`, `monaco-xgis.ts`)
- `maplibre-gl` (`compare-runner.ts`)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
