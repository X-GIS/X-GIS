import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TAG = process.env.ICON_PARITY_TAG ?? 'x'
const OUT = join(HERE, '__icon-render-parity__')
mkdirSync(OUT, { recursive: true })

// Render gate for the #417 collide-overlap grid: the accelerator must not move
// a single pixel. Captures the X-GIS pane on collide-icon-heavy cameras; the
// before/after pair is compared with a directional pixel diff.
const CAMS = [
  { name: 'seoul-bright-z16', style: 'openfreemap-bright', hash: '#16/37.5665/126.9780' },
  { name: 'seoul-liberty-z17', style: 'openfreemap-liberty', hash: '#17/37.5665/126.9780/0/60' },
]

for (const cam of CAMS) {
  test(`icon render ${cam.name}`, async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1800, height: 900 })
    await page.goto(`/compare.html?style=${cam.style}${cam.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 60_000 },
    )
    await page.waitForTimeout(18_000)
    const xg = await page.locator('#panes .pane').nth(1).screenshot()
    writeFileSync(join(OUT, `${cam.name}-${TAG}.png`), xg)
  })
}
