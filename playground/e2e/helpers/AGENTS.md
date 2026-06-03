<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# playground/e2e/helpers

## Purpose
Reusable Playwright helper modules shared across all e2e specs in `playground/e2e/`. Each module is a single-concern utility: visual capture and pixel analysis, WebGPU validation error capture, camera-motion scenario loading, and rAF-driven interaction timing with per-frame stats. All pixel operations happen inside the browser page context via `page.evaluate()` — no node-side image libraries are imported (PNG decoding uses `createImageBitmap` + Canvas 2D).

## Key Files
| File | Description |
|------|-------------|
| `visual.ts` | Canvas capture and pixel assertion utilities. `captureCanvas(page, opts)` — waits for `__xgisReady`, two rAF ticks, optional `elapsedMsAtLeast` threshold, then screenshots `#map`. `sampleNonBackgroundPixels` — counts non-background pixels from a grid sample. `pixelDiffRatio` — fraction of differing pixels between two PNGs (tolerance per channel). `hashScreenshot` — SHA-256 short hex of a buffer. `pixelAt` / `expectPixelAt` — single-pixel RGB extraction and tolerance assertion. `extractRegion` / `expectRegionMatch` — sub-rectangle crop and snapshot baseline. `colorHistogram` / `expectColorHistogram` — bucketed color ratio analysis with per-bucket tolerance and range bounds. |
| `validation.ts` | WebGPU validation error capture. `getValidationErrors(page)` — drains `window.__xgisMap.ctx._validationErrors`. `clearValidationErrors(page)` — resets the queue in place. `withValidationCapture(page, fn)` — wraps a test body and throws aggregating all validation errors fired during it. Catches bind-group, pipeline, buffer/texture size, vertex slot, WGSL compile, and blend/depth state errors. |
| `scenarios.ts` | Camera-motion scenario loader. `loadScenario(name)` — reads `../fixtures/scenarios/<name>.json`, validates schema (all 5 camera fields finite numbers, valid projection enum, valid easing enum), returns typed `Scenario`. `listKnownScenarios()` — returns the 4 known names: `seoul-zoomin`, `manhattan-pitch`, `global-globe-rotation`, `arctic-projection-flip`. Supports all 8 projection types (`mercator` through `oblique_mercator`). |
| `natural-interaction.ts` | rAF-driven natural interaction driver. `runInteraction(page, bodyFn, opts)` — executes a multi-second camera-setter sequence in the page context, collecting per-frame timings. Returns `FrameTimings { frames, totalMs }`. `computeStats(timings)` — derives `{ median, p95, p99, max, count }` from a `FrameTimings`. `interactions` — named factory object with `pan`, `zoom`, `rotate`, `pitch` helpers that build body functions for `runInteraction`. `InteractionOptions`: `durationMs` (default 6000), `easing` function, `verbose` flag. |

## For AI Agents

### Working In This Directory
- All pixel operations decode PNGs inside the page context — pass the buffer as base64 via `page.evaluate()`. Never pull `pngjs` into helper code (it is only used directly in `_pixel-match-*.spec.ts` for pixelmatch comparison).
- `captureCanvas` is the canonical screenshot entry point — never use `page.screenshot()` directly, as it bypasses the `__xgisReady` + rAF quiescence sequence and produces flaky results.
- `withValidationCapture` does NOT pre-clear the queue before calling `fn`; the `page.goto` inside `fn` is what installs `__xgisMap`, so clearing before nav would be a no-op. Errors are drained and asserted after `fn` returns.
- `colorHistogram` bucket assertions must use range bounds `[min, max]` rather than point estimates — exact pixel counts vary with viewport size and DPR. Keep ranges wide enough to survive DPR=1 vs DPR=2 differences.
- `interactions` body functions are stringified and re-evaluated inside `page.evaluate` — they must not close over external variables. Inline all numeric literals as shown in the factory implementations.
- When adding a new helper, keep it focused on a single concern and export only named functions (no default exports, no classes).

### Testing Requirements
- Helpers have no dedicated test files of their own. They are exercised through the specs that import them in `playground/e2e/`.
- If the `withValidationCapture` contract changes (e.g. the `_validationErrors` path on `__xgisMap.ctx`), verify against at least one `_pixel-match-*.spec.ts` and `fixtures.spec.ts`.
- `__screenshots__`, `__probe__`, and other `__*__` output directories in `playground/e2e/` are generated artifacts — one summary line in any description, not enumerated.

### Common Patterns
- Import pattern: `import { captureCanvas, expectPixelAt } from './helpers/visual'`
- All helpers accept `Page` as first argument and return `Promise`.
- `colorHistogram` bucket tolerance of 12 covers AA noise; tighten only for exact-color assertions.
- `FrameTimings.frames` is in chronological ms order; `computeStats` sorts internally — do not pre-sort.

## Dependencies

### Internal
- Reads `../fixtures/scenarios/*.json` (scenarios.ts only)
- Accesses `window.__xgisMap`, `window.__xgisReady` via `page.evaluate`

### External
- `@playwright/test` (type imports only — `Page`)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
