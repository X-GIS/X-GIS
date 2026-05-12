import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__ofm-newbugs__')
mkdirSync(OUT, { recursive: true })

// User-reported OFM Bright cameras 2026-05-12:
//   text + halo issue: #2.26/16.14556/-16683927
//                     #4.37/36.79604/-173.97143
//   polygon/line tile: #2.32/53.22993/-84.35541
for (const cfg of [
  { name: 'cam1-z2.26',  hash: '#2.26/16.14556/-16683927' },
  { name: 'cam2-z4.37',  hash: '#4.37/36.79604/-173.97143' },
  { name: 'cam3-z2.32',  hash: '#2.32/53.22993/-84.35541' },
]) {
  test(`ofm-newbug ${cfg.name}`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1800, height: 900 })
    await page.goto(`/compare.html?style=openfreemap-bright${cfg.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean; __mlReady?: boolean })
        .__xgisReady === true
        && (window as unknown as { __mlReady?: boolean }).__mlReady === true,
      null, { timeout: 30_000 },
    )
    await page.waitForTimeout(10_000)
    const panes = page.locator('#panes .pane')
    const ml = await panes.nth(0).screenshot()
    const xg = await panes.nth(1).screenshot()
    writeFileSync(join(OUT, `${cfg.name}-ml.png`), ml)
    writeFileSync(join(OUT, `${cfg.name}-xg.png`), xg)
  })
}
