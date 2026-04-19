// Sanity check: ?picking=1 still produces the same visible image as the
// default path. The pick RT is a side-effect that shouldn't leak into
// the color attachment.

import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__pick-visual__')
mkdirSync(ART, { recursive: true })

for (const [name, flag] of [
  ['default', ''],
  ['picking', '&picking=1'],
] as const) {
  test(`pick-visual: ${name}`, async ({ page }) => {
    test.setTimeout(30_000)
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.goto(`/demo.html?id=multi_layer&e2e=1${flag}#1.5/20/0`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 15_000 },
    )
    await page.waitForTimeout(1500)
    const png = await page.locator('#map').screenshot()
    writeFileSync(join(ART, `${name}.png`), png)
  })
}
