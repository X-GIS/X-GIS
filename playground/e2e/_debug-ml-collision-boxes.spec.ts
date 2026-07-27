import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__ml-collision__')
mkdirSync(OUT, { recursive: true })

// Ground truth for "why does MapLibre draw one route-14 shield where X-GIS draws
// two?" — `showCollisionBoxes` renders every symbol's collision box and colours
// it by verdict, so it separates "never placed a stop there" from "placed and
// then lost the collision".
test('maplibre collision boxes @ z16 positron', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1800, height: 900 })
  await page.goto('/compare.html?style=openfreemap-positron#16/37.79172/126.79102', {
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
  const enabled = await page.evaluate(() => {
    const w = window as unknown as { __mlMap?: { showCollisionBoxes: boolean } }
    if (!w.__mlMap) return false
    w.__mlMap.showCollisionBoxes = true
    return true
  })
  console.log('showCollisionBoxes set:', enabled)
  await page.waitForTimeout(6_000)
  writeFileSync(join(OUT, 'ml-boxes.png'), await page.locator('#panes .pane').nth(0).screenshot())
})
