// Direct visual diagnosis at the user's repro URL.
// Captures three screenshots in succession:
//   1. baseline — what user actually sees
//   2. fallback-red — fallback ancestor tiles forced red, so we can
//      see which areas are PRIMARY vs ANCESTOR rendering
//   3. depth-always — buildings pipeline forced to depthCompare='always'
//      so depth-test never rejects. If artifact PERSISTS, depth-test
//      isn't the cause. If artifact GETS WORSE, depth-test was doing
//      its job. If GOES AWAY, depth-test was incorrectly rejecting.

import { test } from '@playwright/test'

test.describe('osm_style high-pitch visual diag', () => {
  test('three-shot: baseline / fallback-red / depth-always', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 430, height: 715 })

    // Match user's exact URL
    // User's repro: Tokyo z=17.07 (over-zoom past archive maxLevel=15)
    await page.goto('/demo.html?id=osm_style&e2e=1#17.07/35.68231/139.76596/343.4/18.7', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 })
    await page.waitForTimeout(20_000) // let tiles settle deeply

    await page.screenshot({ path: 'diag-1-baseline.png', fullPage: false })

    await page.evaluate(() => {
      ;(window as unknown as { __XGIS_FALLBACK_RED?: boolean }).__XGIS_FALLBACK_RED = true
    })
    // Trigger a redraw via tiny pan so the new flag takes effect
    const map = page.locator('#map')
    const box = await map.boundingBox()
    if (!box) throw new Error('no map bounds')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2)
    await page.mouse.up()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: 'diag-2-fallback-red.png', fullPage: false })

    // Reset fallback red
    await page.evaluate(() => {
      ;(window as unknown as { __XGIS_FALLBACK_RED?: boolean }).__XGIS_FALLBACK_RED = false
    })
    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'diag-3-confirm-baseline.png', fullPage: false })
  })
})
