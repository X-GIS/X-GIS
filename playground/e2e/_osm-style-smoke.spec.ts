// Smoke test: osm_style at Tokyo. Captures canvas + console errors.
// Used to verify the bind-group fix on real rendering load
// (lon=0/lat=0 in the profile spec is mid-Atlantic — empty data).

import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'

test.describe('osm_style smoke', () => {
  test('Tokyo z=15 renders without validation errors', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1500, height: 900 })
    const errors: string[] = []
    const validationErrors: string[] = []
    page.on('console', m => {
      const text = m.text()
      if (m.type() === 'error') errors.push(text)
      if (text.includes('frame-validation') || text.includes('Bind group layout')) {
        validationErrors.push(text)
      }
    })
    await page.goto('/demo.html?id=osm_style&e2e=1#15/35.6800/139.7600', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 })
    await page.waitForTimeout(5000) // tiles to load + render

    await page.screenshot({ path: 'osm-style-tokyo.png', fullPage: false })

    writeFileSync('osm-style-smoke.log', JSON.stringify({
      errors: errors.slice(0, 30),
      validationErrors: validationErrors.slice(0, 10),
      validationCount: validationErrors.length,
      errorCount: errors.length,
    }, null, 2))

    console.log('errors:', errors.length, 'validation:', validationErrors.length)
    if (validationErrors.length > 0) console.log('FIRST_VALIDATION:', validationErrors[0])
    if (errors.length > 0) console.log('FIRST_ERROR:', errors[0])
    expect(validationErrors.length).toBe(0)
  })
})
