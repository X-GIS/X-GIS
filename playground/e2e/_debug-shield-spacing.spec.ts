import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__shield-spacing__')
mkdirSync(OUT, { recursive: true })

// Measure the on-screen cadence of the OFM Positron "400" route shield chain
// (highway-shield-non-us, symbol-placement: line, symbol-spacing 200) across a
// zoom sweep, in BOTH panes. Tests the model that MapLibre's effective spacing
// is symbol-spacing x 2^frac(zoom) (spacing applied in overscaled tile units)
// while X-GIS's is a constant 200 CSS px.
const ZOOMS = [16.0, 16.2, 16.5, 16.7, 16.9]

for (const z of ZOOMS) {
  test(`shield spacing z${z}`, async ({ page }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 1800, height: 900 })
    await page.goto(`/compare.html?style=openfreemap-positron#${z}/37.79172/126.79102`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
        return w.__xgisReady === true && w.__mlReady === true
      },
      null,
      { timeout: 60_000 },
    )
    await page.waitForTimeout(20_000)
    const panes = page.locator('#panes .pane')
    writeFileSync(join(OUT, `z${z}-ml.png`), await panes.nth(0).screenshot())
    writeFileSync(join(OUT, `z${z}-xg.png`), await panes.nth(1).screenshot())
  })
}
