import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__ofm-positron-shield__')
mkdirSync(OUT, { recursive: true })

// User report 2026-07-27 — OFM Positron @ #16.7/37.79172/126.79102: the "400"
// road shield (box + number, `highway-shield-non-us`, symbol-placement: line at
// z>=11) renders where no road is drawn, in an evenly spaced straight run.
//
// Investigated verdict (see the PR that added this spec):
//   - The floating placement is NOT an X-GIS defect. The feature is
//     `transportation_name` ref=400 / class=`motorway_construction`
//     (수도권제2순환고속도로, under construction). Every Positron road-LINE layer
//     filters `["==", ["get","class"], "motorway"]`, which `motorway_construction`
//     fails, so no line is drawn — while `highway-shield-non-us` has no class
//     filter, so the shield is. MapLibre GL JS renders the same floating chain.
//   - The real divergence is the CADENCE: X-GIS spaces the shields 200 CSS px
//     apart on screen (symbol-spacing applied in screen space), MapLibre spaces
//     them symbol-spacing × 2^frac(zoom) ≈ 325 px (spacing applied in overscaled
//     tile units). At this camera X-GIS emits 4 shields where MapLibre emits 3.
const HASH = '#16.7/37.79172/126.79102'

test('ofm-positron shield 400', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1800, height: 900 })
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
  page.on('requestfailed', (r) => console.log(`[reqfail] ${r.url()} ${r.failure()?.errorText}`))
  await page.goto(`/compare.html?style=openfreemap-positron${HASH}`, {
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
  await page.waitForTimeout(15_000)
  const panes = page.locator('#panes .pane')
  writeFileSync(join(OUT, 'ml.png'), await panes.nth(0).screenshot())
  writeFileSync(join(OUT, 'xg.png'), await panes.nth(1).screenshot())
})
