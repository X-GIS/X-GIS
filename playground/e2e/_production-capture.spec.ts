// Captures from PRODUCTION (deployed gh-pages) — bypasses dev
// server entirely. This is the URL the user actually loads.

import { test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const OUT_DIR = 'test-results/production-capture'
const PROD = 'https://x-gis.github.io/X-GIS/play'

test.describe('Production deployment', () => {
  test.use({ viewport: { width: 1500, height: 907 }, ignoreHTTPSErrors: true })

  test('pmtiles_layered: production gh-pages render at zoom 5/8/10/13', async ({ page }) => {
    test.setTimeout(180_000)
    fs.mkdirSync(OUT_DIR, { recursive: true })

    const states = [
      { name: '01-prod-zoom2', hash: '#2/0/0' },
      { name: '02-prod-zoom5', hash: '#5/35/127' },
      { name: '03-prod-zoom8', hash: '#8/37.5/127.5' },
      { name: '04-prod-zoom10', hash: '#10/37.5665/126.978' },
      { name: '05-prod-zoom13', hash: '#13/37.5665/126.978' },
    ]

    for (const s of states) {
      const url = `${PROD}/demo.html?id=pmtiles_layered${s.hash}`
      console.log('[prod-capture]', s.name, url)
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(8000) // generous settle for production fetch
      const buf = await page.screenshot()
      fs.writeFileSync(path.join(OUT_DIR, `${s.name}.png`), buf)
      console.log('[prod-capture]', s.name, 'saved', buf.length, 'bytes')
    }
  })
})
