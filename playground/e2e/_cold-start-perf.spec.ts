// Cold-start perf budget. Locks in the wins from the 2026-05-08
// session:
//   - IR pipeline parallelised with WebGPU device init
//   - PMTiles header + metadata prewarm
//   - TileJSON manifest prewarm
//   - MVT worker pool prewarm
//   - Self-hosted fonts (no fonts.gstatic.com round trip)
//
// The budgets here are GENEROUS upper bounds — playwright headless
// chromium on a developer machine, no warm cache. They exist to
// detect REGRESSIONS (a future commit that re-serialises the
// pipeline), not to track every-millisecond improvements.

import { test, expect } from '@playwright/test'

interface Timings {
  navStart: number
  domContentLoaded: number
  xgisReady: number
}

async function measureColdStart(
  page: import('@playwright/test').Page, demoId: string,
): Promise<Timings> {
  // Hard navigate (no caching of prior runs).
  const navStart = Date.now()
  await page.goto(`/demo.html?id=${demoId}`, { waitUntil: 'domcontentloaded' })
  const domContentLoaded = Date.now()
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  const xgisReady = Date.now()
  return { navStart, domContentLoaded, xgisReady }
}

test.describe('cold-start perf budgets', () => {
  test('GeoJSON minimal demo: ready within 6 seconds', async ({ page }) => {
    const t = await measureColdStart(page, 'minimal')
    const totalMs = t.xgisReady - t.navStart
    const dclMs = t.domContentLoaded - t.navStart
    const xgisOnlyMs = t.xgisReady - t.domContentLoaded
    // eslint-disable-next-line no-console
    console.log(`[cold-start minimal] nav→dcl=${dclMs}ms, dcl→xgisReady=${xgisOnlyMs}ms, total=${totalMs}ms`)
    // Generous budget — local dev can be slow + Astro+Vite dev server
    // adds module-graph traversal on first request.
    expect(totalMs, `cold start to xgisReady should be < 6s (got ${totalMs}ms)`).toBeLessThan(6000)
  })

  test('PMTiles bright demo: ready within 8 seconds', async ({ page }) => {
    const t = await measureColdStart(page, 'openfreemap_bright')
    const totalMs = t.xgisReady - t.navStart
    // eslint-disable-next-line no-console
    console.log(`[cold-start openfreemap_bright] total=${totalMs}ms`)
    // PMTiles archive header + metadata fetch + a few tile range
    // requests + worker MVT decode + GPU upload. The prewarm should
    // overlap most of the network round trips with the GPU init —
    // budget here flags any commit that re-serialises that.
    expect(totalMs, `cold start to xgisReady should be < 8s (got ${totalMs}ms)`).toBeLessThan(8000)
  })
})
