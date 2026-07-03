<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-29 -->

# playground

## Purpose

Vite 8 development application and Playwright e2e gate for X-GIS. Bundles four HTML pages as separate Rollup entry points: `index.html` (tagged demo gallery with live search), `demo.html` (interactive Monaco editor runner with projection selector and snapshot tool), `compare.html` (MapLibre GL JS left / X-GIS right, camera-synced side-by-side diff across 4 styles including OFM Bright/Liberty/Positron and demotiles), and `debug-labels.html` (touch-interactive per-glyph dump panel for bilingual label debugging). `public/data/` serves Natural Earth GeoJSON at 10m/50m/110m resolution plus fixture GeoJSON files. The `e2e/` suite is the primary integration gate: smoke, animation, reftest, fixture, interaction, pixel-match, perf, and projection-coverage specs run against a real headed Chromium WebGPU context; `XGIS_SOFTWARE_GPU=1` activates SwiftShader for GPU-independent CI gates. `bun run dev` serves at `https://localhost:3000` via self-signed cert with a CORS proxy for third-party PMTiles archives.

## Key Files

| File                   | Description                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`         | Workspace package `@xgis/playground` (private); runtime deps: `@xgis/compiler`, `@xgis/runtime`, `shiki` ^4.0.2; dev deps: `@playwright/test` ^1.59.1, `pixelmatch` ^7.2.0, `pngjs` ^7.0.0, `maplibre-gl` ^5.24.0. Scripts: `dev`, `build`, `test:e2e`.                                                                                                    |
| `vite.config.ts`       | Four named Rollup inputs (`main`, `demo`, `compare`, `debugLabels`), `@vitejs/plugin-basic-ssl`, base path controlled by `XGIS_DEPLOY_BASE=1` for GH Pages (`/X-GIS/play/`), `/pmtiles-proxy/protomaps` CORS proxy for demo-bucket.protomaps.com. `optimizeDeps.exclude` lists `@xgis/compiler`, `@xgis/blueprint`, `@xgis/runtime`.                       |
| `playwright.config.ts` | `testDir=./e2e`, `globalTeardown=_demo-audit-report.ts`, 60s timeout, 2 workers (overrideable via `WORKERS` env), Chromium `--enable-unsafe-webgpu`, `headless=false` by default (system GPU required), `XGIS_SOFTWARE_GPU=1` SwiftShader path for CI, `XGIS_USE_SYSTEM_CHROME=1` for WSL2, visual thresholds `threshold=0.15` / `maxDiffPixelRatio=0.01`. |
| `demo.html`            | Full interactive runner shell: Monaco editor pane (resizable, mobile-collapsible via gear toggle with `aria-label`), `#map` canvas, projection selector (all 8 surfaces), prev/next navigation, "Copy snapshot" button (`__xgisSnapshot()` → clipboard JSON), Mapbox-import button. Entry: `src/demo-runner.ts`.                                           |
| `index.html`           | Gallery landing page with category sections, live search, demo count badge. Entry: `src/gallery.ts`.                                                                                                                                                                                                                                                       |
| `compare.html`         | MapLibre GL JS left / X-GIS right, camera sync via last-write-wins URL hash `#z/lat/lon/bearing/pitch`. Entry: `src/compare-runner.ts`.                                                                                                                                                                                                                    |
| `debug-labels.html`    | Touch-interactive OFM Bright map; on-screen glyph dump (cp/x/y/bearingY/height) via `map.setLabelDumpFilter` / `getDumpedLabels`. Entry: `src/debug-labels.ts`.                                                                                                                                                                                            |
| `tsconfig.json`        | Extends `../tsconfig.base.json`; types `@webgpu/types`, `node`, `vite/client`; `noEmit: true`; includes `src/**/*.ts` only.                                                                                                                                                                                                                                |

## Subdirectories

| Directory        | Purpose                                                                                                                                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`           | TypeScript entry-point modules (`demo-runner.ts`, `gallery.ts`, `compare-runner.ts`, `debug-labels.ts`, `monaco-xgis.ts`, `xgis-inspector.ts`, `web-entry.ts`, `mapbox-projection.ts`, `demos.ts`), the `demos/` per-category fragments + loader, and `examples/` `.xgis` demo/fixture sources (see `src/AGENTS.md`). |
| `e2e/`           | Playwright spec files (~100 specs), `helpers/` (`visual.ts`, `validation.ts`), `_demo-audit-report.ts` teardown, and `__*__` screenshot/probe output dirs (see `e2e/AGENTS.md`).                                                                                                                                      |
| `e2e-fixtures/`  | Crash-replay snapshots (`bug-snapshot.json`) captured from the live production site for `_snapshot-replay.spec.ts` (see `e2e-fixtures/AGENTS.md`).                                                                                                                                                                    |
| `examples/`      | Standalone HTML embedding examples (18 files) for `<xgis-map>` custom element and imperative `XGISMap` API, no Monaco IDE (see `examples/AGENTS.md`).                                                                                                                                                                 |
| `public/`        | Static assets: Natural Earth GeoJSON/`.xgt` tiles at 10m/50m/110m, fixture GeoJSON files, style JSON, `libs/` (see `public/AGENTS.md`).                                                                                                                                                                               |
| `scripts/`       | One-off diagnostic probes run via `bun run scripts/<file>.ts` — not part of build or test pipeline (see `scripts/AGENTS.md`).                                                                                                                                                                                         |
| `render-verify/` | Render-verify matrix oracle support (`matrix.manifest.ts`, `matrix-oracles.ts`, `evaluator.ts`, `camera-map.ts`, `pixelmatch-browser.ts`) plus the human-blessed `baselines/` PNG corpus (see `render-verify/baselines/README.md`).                                                                                   |

## For AI Agents

### Working In This Directory

- **Adding a demo**: create `src/examples/<id>.xgis`, add an entry to the matching `src/demos/<category>.ts` fragment (`name`, `tag`, `description`, `source`, optional `picking: true`) — `src/demos.ts` only spreads the fragments. Gallery and demo-select populate automatically via the `import.meta.glob` in `src/demos/loader.ts`.
- `window.__xgisMap` (set by `demo-runner.ts`) and `window.__xgisReady` (set by the runtime after first frame) are load-bearing for every e2e spec — do not rename.
- `src/web-entry.ts` is a thin re-export (`XGISMap`, `registerXGISElement`) used as the library entry point for the examples/ pages.
- `src/xgis-inspector.ts` is activated by `?profile=1` (optionally `?gpuprof=1` for GPU timestamp data); reads live state from `window.__xgisMap` at 4 Hz — do not couple it to internal fields that may be renamed.
- **Never use `GITHUB_ACTIONS` to control the Vite base path** — use `XGIS_DEPLOY_BASE=1` only in the deploy step. CI playground-audit leaves it unset so `baseURL=https://localhost:3000` resolves without rewrites.
- PMTiles URL rewrites (`URL_REWRITES`) in `src/demos/loader.ts` are applied in both dev and prod (the protomaps demo bucket is dead/404); the protomaps API key is restricted to `https://x-gis.github.io` in the protomaps dashboard and CORS-exempt from localhost.
- Camera hash `#z/lat/lon[/bearing/pitch]` is duplicated in `demo-runner.ts` and `compare-runner.ts`; keep them in sync.
- `WORKERS` env overrides the default 2 Playwright workers; lower to 1 on slower hardware to eliminate GPU-contention flakes.
- `XGIS_SOFTWARE_GPU=1` activates SwiftShader args; only GPU-independent specs run correctly in this mode — pixel-survey specs must stay on the hardware-GPU headed path.

### Testing Requirements

- Run `bun run test:e2e` from this directory. The `webServer` block auto-starts `bun run dev` if not already running.
- Core stable suites: `e2e/smoke.spec.ts` (production demos, 3-phase: errors + baseline screenshot + non-bg pixel sample), `e2e/animation.spec.ts` (cycle continuity via hash + color histogram), `e2e/reftest.spec.ts` (Mozilla-style render-identical pairs), `e2e/fixtures.spec.ts` (per-renderer isolation fixtures), `e2e/interactions.spec.ts` (risky feature combos with WebGPU validation capture), `e2e/worldwrap-z0.spec.ts`, `e2e/miter-check.spec.ts`.
- Investigative `_*.spec.ts` specs (prefixed with `_`) are not gated in CI; run individually when debugging a specific subsystem.
- Visual baselines in `e2e/smoke.spec.ts-snapshots/`; rebake with `playwright test --update-snapshots` when render output intentionally changes.
- `e2e/helpers/visual.ts` is the canonical screenshot helper (`captureCanvas` with `__xgisReady` + 2 rAF quiescence); always use it, never `page.screenshot()` directly.
- `e2e/helpers/validation.ts` wraps test bodies in `withValidationCapture` to surface WebGPU bind-group/pipeline errors as hard failures.

### Common Patterns

- `captureCanvas(page, { elapsedMsAtLeast: N })` drives animation tests to a known clock position before sampling.
- `colorHistogram` + `expectColorHistogram` are preferred over pixel-exact baselines for tile-heavy and animated demos where frame content drifts between runs.
- Reftest pairs use `pixelDiffRatio` (tolerance ±12/255, max 0.5% pixels) rather than byte equality — WebGPU MSAA resolve introduces sub-pixel jitter.
- All pixel decoding runs in-page via `createImageBitmap` + 2D canvas; no node-side image library is needed for the core suites.

## Dependencies

### Internal

- `@xgis/runtime` — `XGISMap`, `registerXGISElement`, `lonLatToMercator`
- `@xgis/compiler` — `convertMapboxStyle`, `validateSource`, `discoverFields`

### External

- `vite` ^8.0.8, `@vitejs/plugin-basic-ssl` ^2.3.0
- `@playwright/test` ^1.59.1
- `monaco-editor` (loaded from `node_modules` via Vite; not a direct package.json dep)
- `maplibre-gl` ^5.24.0 (compare-runner.ts only)
- `pixelmatch` ^7.2.0, `pngjs` ^7.0.0 (pixel-diff investigative specs)
- `shiki` ^4.0.2 (syntax highlighting in gallery)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
