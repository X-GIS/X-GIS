// Aggressive opacity error repro — osm-style.xgis is temporarily
// edited with opacity-50 on buildings AND roads_highway. Test loads
// at multiple URLs the user has reported and dumps every console
// error / pageerror.

import { test } from '@playwright/test'
import { writeFileSync } from 'node:fs'

const TARGET_URLS = [
  '#16.78/35.68311/139.76636/335.1/76.7',
  '#16.33/35.68524/139.76573/2.6/63.5',
  '#17.07/35.68231/139.76596/343.4/18.7',
  '#15.78/37.53155/126.97068/348.1/85.0',
  '#15/35.68/139.76/0/0',
]

test.describe('opacity error scan', () => {
  for (const url of TARGET_URLS) {
    test(`url=${url}`, async ({ page }) => {
      test.setTimeout(60_000)
      await page.setViewportSize({ width: 1280, height: 800 })
      const errors: string[] = []
      const warnings: string[] = []
      page.on('console', m => {
        const t = m.text()
        if (m.type() === 'error') errors.push(t)
        if (m.type() === 'warning') warnings.push(t)
      })
      page.on('pageerror', e => { errors.push('PAGE_ERROR: ' + e.message) })

      await page.goto(`/demo.html?id=osm_style&e2e=1${url}`, {
        waitUntil: 'domcontentloaded',
      })
      await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
        null, { timeout: 30_000 })
      await page.waitForTimeout(10_000)

      // eslint-disable-next-line no-console
      console.log(`url=${url} errors=${errors.length} warnings=${warnings.length}`)
      if (errors.length > 0) {
        // eslint-disable-next-line no-console
        console.log('FIRST_ERROR:', errors[0].substring(0, 500))
        const fname = `opacity-fail-${url.replace(/[/.#]/g, '_')}.log`
        writeFileSync(fname, JSON.stringify({
          url, errors: errors.slice(0, 10), warnings: warnings.slice(0, 5),
        }, null, 2))
      }
    })
  }
})
