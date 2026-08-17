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
  globalTeardown: './e2e/_demo-audit-report.ts',
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
  // CI retries. The render-gate leg drives ~46 SwiftShader render/readback gates
  // on a 4-core runner, and it failed twice in one session on DIFFERENT tests,
  // both as bare 60 s timeouts — `_vs-clip-parity` in page.evaluate,
  // `_shader-dsl-mouse-interaction` in page.goto — where the same tests take 8 s
  // and 4 s locally and passed on re-run. A software rasterizer starved 3-6× past
  // its budget is the shape of that, not a defect in either test.
  //
  // Retrying does NOT hide a failure: Playwright reports a retry-pass as FLAKY,
  // distinct from passed, so a test that needs a retry stays visible in the run
  // summary — what it stops is a transient timeout blocking an otherwise-green
  // merge. It does mean an intermittent REAL regression takes longer to surface,
  // which is the accepted trade; the durable fix is deterministic settling inside
  // the specs that assert on frame-to-frame change (the settle-until-N-identical-
  // hashes pattern), not a retry.
  //
  // Local runs keep 0 so a flake in front of a developer is seen, not smoothed.
  retries: process.env.CI ? 2 : 0,
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
      // XGIS_CHROMIUM_EXECUTABLE: point Playwright at a pre-provisioned
      // Chromium (e.g. /opt/pw-browsers/chromium in cloud/e2e containers that
      // skip per-version browser downloads). Mirrors the WSL system-Chrome
      // escape hatch below; unset = the bundled Chromium as before.
      ...(process.env.XGIS_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.XGIS_CHROMIUM_EXECUTABLE }
        : {}),
      // XGIS_SOFTWARE_GPU=1 (CI on GitHub Linux runners with no GPU):
      // force the SwiftShader Vulkan ICD so WebGPU enumerates a software
      // adapter headlessly. Only the GPU-INDEPENDENT gates run in this mode
      // (projection-coverage skips paint via the same env var; shader-math
      // parity is a pure compute pass). The full raster pipeline / pixel
      // survey do NOT render correctly under SwiftShader, so they stay on
      // the hardware-GPU (headed) path and are not run in this mode.
      args: [
        ...(process.env.XGIS_SOFTWARE_GPU === '1'
          ? [
              '--enable-unsafe-webgpu',
              '--enable-unsafe-swiftshader',
              '--use-angle=swiftshader',
              '--use-vulkan=swiftshader',
              '--enable-features=Vulkan',
            ]
          : ['--enable-unsafe-webgpu', '--enable-features=Vulkan']),
        // XGIS_BROWSER_PROXY (#1611 step-0): containerized runners route ALL
        // egress through an HTTP(S) proxy. curl/node honor HTTPS_PROXY, but
        // Chromium never reads env proxies, so a network-dependent spec (an
        // OpenFreeMap style/glyph fetch) hangs at boot and times out looking
        // like a map bug. Opt-in pass-through; the proxy's CA must already be
        // in the browser trust store (the cloud image installs it in NSS).
        ...(process.env.XGIS_BROWSER_PROXY
          ? [`--proxy-server=${process.env.XGIS_BROWSER_PROXY}`]
          : []),
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // XGIS_USE_SYSTEM_CHROME=1: use system Chrome via Playwright's
        // 'chrome' channel. Needed on WSL2 Ubuntu 26.04 where the
        // PW 1.59 bundled Chromium build is unavailable. Other dev
        // boxes leave the env var unset and use the bundled Chromium.
        ...(process.env.XGIS_USE_SYSTEM_CHROME === '1' ? { channel: 'chrome' } : {}),
      },
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
