import { test } from '@playwright/test'
test('probe', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto('/demo.html?id=fixture_pattern_multi&forcegl2=1&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 35_000 })
  await page.waitForTimeout(8000)
  await page.evaluate(() => { (window as any).__xgisLineTiles.length = 0; (window as any).__xgisMap?.invalidate?.() })
  await page.waitForTimeout(1500)
  console.log('TILES', JSON.stringify(await page.evaluate(() => (window as any).__xgisLineTiles)))
})
