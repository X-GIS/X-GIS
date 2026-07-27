import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__paired-collision__')
mkdirSync(OUT, { recursive: true })
const TAG = process.env.PAIRED_TAG ?? 'x'

// Paired-symbol collision parity. MapLibre's own collision debug rejects the
// second route-14 shield against the "Wijeon-ri" place label here; X-GIS used to
// render both because a shield collided on its ref glyphs, not its badge.
test('paired shield vs place label @ z16 positron', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1800, height: 900 })
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text()}`)
  })
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
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
  await page.waitForTimeout(20_000)
  const panes = page.locator('#panes .pane')
  writeFileSync(join(OUT, `ml-${TAG}.png`), await panes.nth(0).screenshot())
  writeFileSync(join(OUT, `xg-${TAG}.png`), await panes.nth(1).screenshot())
})
