<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# playground

## Purpose
Vite 8 development application for X-GIS. Hosts the interactive demo gallery (`index.html`/`demo.html`) with Monaco editor, a MapLibre side-by-side comparison page (`compare.html`), a mobile label-debug page (`debug-labels.html`), and the full Playwright end-to-end test suite covering smoke, fixture, interaction, reftest, pixel-match, performance, and projection-coverage scenarios. All four HTML pages are bundled as separate Rollup entry points; `bun run dev` serves them at `https://localhost:3000` using a self-signed cert and a CORS proxy for third-party PMTiles archives.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Workspace package `@xgis/playground`; deps on `@xgis/compiler`, `@xgis/runtime`, `shiki`; dev deps: Playwright 1.59, pixelmatch, pngjs, maplibre-gl. Scripts: `dev`, `build`, `test:e2e`. |
| `vite.config.ts` | Vite 8 config: HTTPS via `@vitejs/plugin-basic-ssl`, base path controlled by `XGIS_DEPLOY_BASE=1` for GH Pages (`/X-GIS/play/`), `/pmtiles-proxy/protomaps` CORS proxy, four named Rollup inputs. |
| `playwright.config.ts` | Playwright config: `testDir=./e2e`, `globalTeardown=_demo-audit-report.ts`, 60s timeout, 2 workers (GPU contention), Chromium with `--enable-unsafe-webgpu`, `baseURL=https://localhost:3000`, visual regression thresholds (`threshold=0.15`, `maxDiffPixelRatio=0.01`), `headless=false` (system GPU required for WebGPU). |
| `index.html` | Gallery page entry point; loads `src/gallery.ts`. |
| `demo.html` | Interactive demo runner entry point; loads `src/demo-runner.ts`. URL param `?id=<demoId>`, camera in hash `#z/lat/lon/bearing/pitch`. |
| `compare.html` | Side-by-side MapLibre ↔ X-GIS comparison; loads `src/compare-runner.ts`. |
| `debug-labels.html` | Mobile label-debug page; loads `src/debug-labels.ts`. Exposes per-glyph dump panel for bilingual label inspection. |
| `tsconfig.json` | TypeScript config for the playground package. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | TypeScript entry-point modules and `.xgis` example files (see `src/AGENTS.md`). |
| `e2e/` | Playwright spec files, helpers, fixtures, and spec-invariants (see `e2e/AGENTS.md`). |
| `e2e-fixtures/` | Crash-replay snapshots captured from the live production site (see `e2e-fixtures/AGENTS.md`). |
| `examples/` | Standalone HTML examples for embedding X-GIS without the Monaco IDE (see `examples/AGENTS.md`). |
| `scripts/` | One-off diagnostic scripts run with `bun run` (see `scripts/AGENTS.md`). |
| `public/` | Static assets served by Vite: GeoJSON data files, `.xgt` tiles, JSON style overrides (see `public/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- `bun run dev` starts the Vite dev server at `https://localhost:3000`. The self-signed cert requires `ignoreHTTPSErrors: true` in Playwright and manual browser trust on first load.
- **Do not set `GITHUB_ACTIONS` to control the base path** — use `XGIS_DEPLOY_BASE=1` only for the GH Pages deploy step; all other CI leaves it unset so e2e `baseURL` hard-coded to `https://localhost:3000` resolves correctly.
- WebGPU requires a headed Chromium session (`headless: false` default in `playwright.config.ts`). Set `HEADED=0` only if a GPU-enabled CI runner is available.
- `WORKERS` env overrides the default 2 parallel Playwright workers; lowering to 1 eliminates GPU-contention flakes on slower machines.
- Production URL rewrites for PMTiles are handled in `src/demos.ts`; dev URLs use the `/pmtiles-proxy/protomaps` Vite proxy.

### Testing Requirements
- Run `bun run test:e2e` from this directory (not repo root).
- Visual regression baselines live under `e2e/<spec>.spec.ts-snapshots/`; regenerate with `-- --update-snapshots`.
- Pixel-match specs (`_pixel-match-*.spec.ts`) set `workers: 1` internally — do not override to parallel.
- `__xgisReady` is the global flag set by the engine after first-frame completion; all specs wait on it before screenshots or assertions.

### Common Patterns
- All four HTML pages share the camera hash format `#z/lat/lon[/bearing/pitch]`.
- Demo sources are Vite-inlined `.xgis` files via `import.meta.glob('*.xgis', { query: '?raw' })`.
- `window.__xgisMap` is the live `XGISMap` instance exposed by the demo runner for test access.
- The `_demo-audit-report.ts` global teardown aggregates per-spec results into a summary JSON.

## Dependencies

### Internal
- `@xgis/compiler` — `convertMapboxStyle`, `LANGUAGE_SCHEMA`, lexer/parser (used by `compare-runner.ts`, `debug-labels.ts`)
- `@xgis/runtime` — `XGISMap`, `registerXGISElement`, `lonLatToMercator`

### External
- `vite` ^8.0.8, `@vitejs/plugin-basic-ssl` ^2.3.0
- `@playwright/test` ^1.59.1
- `maplibre-gl` ^5.24.0 (comparison page only)
- `pixelmatch` ^7.2.0, `pngjs` ^7.0.0 (pixel-diff specs)
- `shiki` ^4.0.2 (syntax highlighting in gallery)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
