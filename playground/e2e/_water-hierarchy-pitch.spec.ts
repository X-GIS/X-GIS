// Bug capture — `water_hierarchy` demo, FLICKER warnings + visual
// fragmentation at high pitch.
//
// Reported state:
//   #13.50/24.25169/91.09138/345.0/34.2 → ~1.5 second freeze, then
//     fragmented blue stripes. Console shows ~100 [FLICKER] warnings
//     (`tiles without fallback (z=14 gpuCache=512)`) within seconds.
//   #13.50/24.22985/91.09184/330.0/79.9 → similar warnings; near-empty
//     viewport.
//
// Suspected root cause: at high pitch, the camera frustum sees many
// more tiles than the GPU cache (512 entries) can hold AND the
// per-frame upload budget (4 tiles) can promote. Without parent-tile
// fallbacks, missing tiles render as black/empty until their data
// arrives — producing the visible stripes and persistent FLICKER
// warnings. Pitch-aware LOD or a much larger GPU cache + upload budget
// would address it.
//
// Test strategy: visit each URL, capture FLICKER console warnings over
// a 4-second observation window after the camera settles. Assert the
// FLICKER count stays small. Currently fails (100+); turns green when
// the tile budget / LOD strategy is fixed.
//
// Marked `.fail` per the same convention as _dashed-corner.spec.ts.

import { test, expect } from '@playwright/test'

const FLICKER_BUDGET = 5

async function loadAndObserve(page: import('@playwright/test').Page, hash: string): Promise<{ flicker: number; sample: string[] }> {
  const flickers: string[] = []
  const onMsg = (m: import('@playwright/test').ConsoleMessage) => {
    const t = m.text()
    if (t.includes('[FLICKER]')) flickers.push(t)
  }
  page.on('console', onMsg)

  await page.goto(`/demo.html?id=water_hierarchy&e2e=1${hash}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 20_000 },
  )
  // Allow tile loads to settle. The 60-frame grace window inside the
  // map (~1s at 60fps) intentionally swallows the initial-load FLICKER
  // burst, so we wait past it before counting.
  await page.waitForTimeout(2000)
  // Reset the captured-list AFTER the grace window so we only count
  // sustained FLICKER (the actual bug) not initial-load noise.
  flickers.length = 0

  // Drive a small pan motion so the tile cache is exercised — at high
  // pitch, the bug manifests as the camera moves through new horizon
  // tiles. A static frame after grace shows zero FLICKER on most dev
  // machines; a moving camera reliably reproduces it.
  const rect = await page.evaluate(() => {
    const c = document.querySelector('#map') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  })
  await page.mouse.move(rect.cx, rect.cy)
  await page.mouse.down()
  // Pan in a small circle for ~3 seconds.
  const start = Date.now()
  while (Date.now() - start < 3000) {
    const t = (Date.now() - start) / 1000
    const dx = Math.cos(t * 2) * 80
    const dy = Math.sin(t * 2) * 60
    await page.mouse.move(rect.cx + dx, rect.cy + dy)
    await page.waitForTimeout(50)
  }
  await page.mouse.up()
  await page.waitForTimeout(500)

  page.off('console', onMsg)
  return { flicker: flickers.length, sample: flickers.slice(0, 5) }
}

// 34° pitch reproduction is environment-dependent — the user's
// machine sustains FLICKER warnings at this state, but a headless
// run on this dev machine does not. Marked `.fixme` so the bug is
// documented in the suite without producing a flaky CI signal.
// Re-enable (swap to `.fail` or plain `test`) once reproduction
// stabilises or the underlying tile-budget fix lands.
test.fixme('water_hierarchy at moderate pitch (34°) does not sustain FLICKER warnings', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1200, height: 800 })
  const { flicker, sample } = await loadAndObserve(page, '#13.50/24.25169/91.09138/345.0/34.2')
  console.log(`[water-hierarchy 34°] FLICKER count: ${flicker} — sample: ${JSON.stringify(sample)}`)
  expect(flicker).toBeLessThanOrEqual(FLICKER_BUDGET)
})

test.fail('water_hierarchy at high pitch (80°) does not sustain FLICKER warnings', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1200, height: 800 })
  const { flicker, sample } = await loadAndObserve(page, '#13.50/24.22985/91.09184/330.0/79.9')
  console.log(`[water-hierarchy 80°] FLICKER count: ${flicker} — sample: ${JSON.stringify(sample)}`)
  expect(flicker).toBeLessThanOrEqual(FLICKER_BUDGET)
})
