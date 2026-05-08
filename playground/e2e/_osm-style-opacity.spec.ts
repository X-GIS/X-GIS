// Repro: user reports error when adding opacity to osm_style.
// Buildings layer has extrude — adding opacity flips the bucket-
// scheduler classification to isOitExtrude, routing draws through
// the OIT fill + compose pipeline. Capture errors + screenshot.

import { test } from '@playwright/test'
import { writeFileSync } from 'node:fs'

test.describe('osm_style + opacity error repro', () => {
  test('buildings opacity-50 — capture errors', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 430, height: 715 })
    const errors: string[] = []
    const validations: string[] = []
    page.on('console', m => {
      const t = m.text()
      if (m.type() === 'error') errors.push(t)
      if (t.includes('frame-validation') || t.includes('Bind group') || t.includes('shader')) {
        validations.push(t)
      }
    })
    // osm-style.xgis source has been temporarily patched with
    // `opacity-50` on the buildings layer; load the demo and watch
    // for errors / validation messages.
    await page.goto('/demo.html?id=osm_style&e2e=1#16/35.68/139.76/0/45', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 })
    await page.waitForTimeout(10000)
    await page.screenshot({ path: 'opacity-error.png', fullPage: false })

    writeFileSync('opacity-error.log', JSON.stringify({
      errors: errors.slice(0, 30),
      validations: validations.slice(0, 30),
      errorCount: errors.length,
      validationCount: validations.length,
    }, null, 2))

    console.log('errors:', errors.length, 'validations:', validations.length)
    if (errors.length > 0) console.log('FIRST_ERROR:', errors[0])
  })
})
