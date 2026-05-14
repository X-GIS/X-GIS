import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for X-GIS playground e2e smoke tests.
 *
 * The smoke test loads every demo from DEMOS and asserts:
 *  - No console.error fires during initial load
 *  - No [X-GIS pass:*] or [X-GIS frame-validation] errors in the
 *    in-page overlay log
 *  - Canvas has non-zero visible pixels after __xgisReady
 *
 * Targets the Vite dev server at https://localhost:3000 (HTTPS via
 * @vitejs/plugin-basic-ssl, self-signed cert accepted via
 * ignoreHTTPSErrors).
 *
 * Chromium is launched with --enable-unsafe-webgpu so WebGPU works
 * in headless mode. Default Playwright 1.59+ ships with WebGPU-
 * capable Chromium; no extra binaries needed.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // Worker parallelization. The bottleneck is GPU contention, not
  // CPU — Windows headed Chromium throttles aggressively when
  // multiple WebGPU contexts share an adapter. Empirical: 4+ workers
  // produced 2-3× slower runs than 1-2 workers on the user's dev
  // environment (sustained WebGPU contention starves each session
  // of GPU time even though task counts look low).
  //
  // Historical note (pre-2026-05-15): config defaulted to 4 with a
  // comment claiming "sweet spot". That measurement came from a
  // different GPU / driver combination; on the production dev box
  // 4 workers consistently REGRESSES wall-time. Default lowered to
  // 2 (overrideable via WORKERS env). Pixel-match specs use serial
  // mode unconditionally — see _pixel-match-*.spec.ts.
  fullyParallel: true,
  workers: Number(process.env.WORKERS ?? 2),
  reporter: [['list']],
  // Visual regression baselines (PR B). Per-pixel match is too strict
  // for WebGPU output across drivers / GPU vendors — a small tolerance
  // catches real regressions without flagging anti-aliasing noise.
  // Threshold = max per-channel diff (0..1); maxDiffPixelRatio = max
  // fraction of pixels allowed to differ. Numbers calibrated for the
  // X-GIS dev environment; adjust the rebake doc if a new GPU lands
  // in CI.
  expect: {
    toHaveScreenshot: {
      threshold: 0.15,
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    baseURL: 'https://localhost:3000',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    // Headless Chromium on Windows fails to enumerate a WebGPU adapter
    // ("No available adapters"), which drops the engine into Canvas 2D
    // fallback — and Canvas 2D doesn't support XGVT tile parsing, so
    // every vector-tile demo fails with a JSON parse error on
    // "XGVT...". Running headed uses the actual system GPU (D3D/Vulkan)
    // and WebGPU works. Override with HEADED=0 for CI once we have a
    // working GPU-enabled runner.
    headless: process.env.HEADED === '0',
    launchOptions: {
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun run dev',
    url: 'https://localhost:3000/demo.html?id=minimal',
    reuseExistingServer: true,
    timeout: 60_000,
    ignoreHTTPSErrors: true,
  },
})
