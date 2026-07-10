import { defineConfig, devices } from '@playwright/test'

// Drive the astro-dev site (:4321, https via basic-ssl) with headless Chromium
// on the macOS runner. `--enable-unsafe-webgpu` exposes WebGPU; `--use-angle=metal`
// routes it through the real Metal backend (the whole point — Apple fast-math).
export default defineConfig({
  testDir: '.',
  testMatch: /probe\.spec\.ts/,
  timeout: 240_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'https://localhost:4321',
    ignoreHTTPSErrors: true,
    headless: false, // macOS runners have an Aqua session — headed avoids headless GL/WebGPU wedges
    launchOptions: {
      args: ['--enable-unsafe-webgpu', '--use-angle=metal'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
