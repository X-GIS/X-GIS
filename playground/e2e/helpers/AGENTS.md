<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# playground/e2e/helpers

## Purpose
Reusable Playwright helper modules shared across all e2e specs. Each module is a focused utility layer: visual capture and pixel analysis, WebGPU validation error capture, camera-motion scenario loading, and natural rAF-driven interaction timing. All helpers operate by evaluating code in the page context via `page.evaluate()` — no node-side image libraries are pulled in (pixel decoding happens inside the browser via `createImageBitmap` + Canvas 2D).

## Key Files
| File | Description |
|------|-------------|
| `visual.ts` | Canvas capture and pixel assertion utilities. `captureCanvas(page, opts)` — waits for `__xgisReady`, two rAF ticks, optional `elapsedMsAtLeast` threshold, then screenshots `#map`. `sampleNonBackgroundPixels` — counts non-background pixels from a grid sample. `pixelDiffRatio` — fraction of differing pixels between two PNGs. `hashScreenshot` — SHA-256 short hex of a buffer. `pixelAt` / `expectPixelAt` — single-pixel RGB extraction and tolerance assertion. `extractRegion` / `expectRegionMatch` — sub-rectangle crop and snapshot baseline. `colorHistogram` / `expectColorHistogram` — bucketed color ratio analysis with per-bucket tolerance and range assertion. |
| `validation.ts` | WebGPU validation error capture. `getValidationErrors(page)` — drains `window.__xgisMap.ctx._validationErrors`. `clearValidationErrors(page)` — resets the queue. `withValidationCapture(page, fn)` — wraps a test body and throws if any validation error fires during it. Catches bind group, pipeline, buffer/texture size, vertex slot, WGSL compile, and blend/depth state errors. |
| `scenarios.ts` | Camera-motion scenario loader. `loadScenario(name)` — reads `fixtures/scenarios/<name>.json`, validates schema (all 5 camera fields finite numbers, valid projection enum, valid easing enum), returns typed `Scenario`. `listKnownScenarios()` — returns the 4 known scenario names. |
| `natural-interaction.ts` | rAF-driven natural interaction driver. Runs multi-second pan/zoom/pitch sequences in the page context, collecting per-frame timing. Returns `FrameTimings { frames: number[], totalMs }` for p95/max performance assertions. `InteractionOptions`: `durationMs` (default 6000), `easing` function, `verbose` flag. |

## Subdirectories
*(none)*

## For AI Agents

### Working In This Directory
- All pixel operations decode PNGs inside the page context — pass the buffer as base64 via `page.evaluate()`. Never pull `pngjs` into helper code (it is only used directly in `_pixel-match-*.spec.ts` for pixelmatch comparison).
- `captureCanvas` is the canonical way to take a screenshot from any spec — never use `page.screenshot()` directly, as it bypasses the `__xgisReady` + rAF quiescence sequence and produces flaky results.
- `withValidationCapture` clears and drains the `_validationErrors` queue that `runtime/src/engine/gpu.ts initGPU()` installs. If the page has not navigated yet when `withValidationCapture` is called, the queue may not exist — ensure navigation happens inside the `fn` callback.
- `colorHistogram` bucket assertions are intentionally loose (range `[min, max]` not point). This is by design — exact pixel counts vary with viewport size and DPR. Keep thresholds wide enough to survive DPR=1 vs DPR=2 differences.
- When adding a new helper, keep it focused on a single concern and export only named functions (no default exports, no classes).

### Testing Requirements
- Helpers have no dedicated test files. They are exercised through the specs that import them.
- If you change the `withValidationCapture` contract (e.g. the `_validationErrors` path on `__xgisMap`), verify against `fixtures.spec.ts` and at least one `_pixel-match-*.spec.ts`.

### Common Patterns
- Import pattern: `import { captureCanvas, expectPixelAt } from './helpers/visual'`
- All helpers accept `Page` as first argument and return Promises.
- `colorHistogram` bucket tolerance of 12 covers AA noise; tighten only for exact-color assertions.
- `FrameTimings.frames` is in chronological ms order; compute p95 as `frames.sort()[Math.floor(frames.length * 0.95)]`.

## Dependencies

### Internal
- Reads `fixtures/scenarios/*.json` (scenarios.ts only)
- Accesses `window.__xgisMap`, `window.__xgisReady` via `page.evaluate`

### External
- `@playwright/test` (type imports only — `Page`)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
