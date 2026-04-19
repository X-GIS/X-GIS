import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__line-regressions__')
mkdirSync(ART, { recursive: true })

test('full outset', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 1200 })
  await page.goto('/demo.html?id=fixture_stroke_outset&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true, null, { timeout: 15_000 },
  )
  await page.waitForTimeout(500)
  const png = await page.locator('#map').screenshot()
  writeFileSync(join(ART, 'full-outset.png'), png)
})
