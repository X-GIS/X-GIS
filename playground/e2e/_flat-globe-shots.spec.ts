import { test } from '@playwright/test'
import { mkdirSync } from 'fs'

// Manual capture (leading `_` opts out of smoke): renders a world-scale demo
// in flat Mercator (projType 0) vs globe (projType 7) and saves a PNG of each,
// so the projection-display-layer-restore fix can be confirmed visually.
//   bunx playwright test _flat-globe-shots.spec.ts --workers=1

const OUT = 'D:/X-GIS/.omc/shots'
mkdirSync(OUT, { recursive: true })

const waitFrames = (page: import('@playwright/test').Page) =>
  page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

test.use({ viewport: { width: 860, height: 860 } })

test('capture flat Mercator vs globe', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/demo.html?id=physical_map#2/20/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 30_000 })
  await waitFrames(page)
  await waitFrames(page)

  // Flat Mercator (default).
  await page.evaluate(() => (window as any).__xgisMap.setProjection('mercator'))
  await page.waitForTimeout(500)
  await waitFrames(page)
  await page.locator('#map').screenshot({ path: `${OUT}/mercator-flat.png` })

  // Globe.
  await page.evaluate(() => (window as any).__xgisMap.setProjection('globe'))
  await page.waitForTimeout(600)
  await waitFrames(page)
  await page.locator('#map').screenshot({ path: `${OUT}/globe.png` })

  // Back to flat at a regional zoom to show line↔fill alignment holds.
  await page.evaluate(() => {
    const m = (window as any).__xgisMap
    m.setProjection('mercator')
  })
  await page.waitForTimeout(500)
  await waitFrames(page)
  await page.locator('#map').screenshot({ path: `${OUT}/mercator-flat-2.png` })
})
