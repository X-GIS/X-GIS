import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

// Baseline capture of the 3 globe vector-fidelity artifacts (inner sphere /
// tessellation gaps / hi-zoom) on ocean_land (coarse ne_110m land + ocean).
async function shoot(page: import('@playwright/test').Page, hash: string, file: string) {
  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.goto(`/demo.html?id=ocean_land&e2e=1#${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true, null, { timeout: 20_000 })
  // Force globe projection via the public API (robust vs URL-param override).
  await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: { setProjection?: (p: string) => void } }).__xgisMap
    m?.setProjection?.('globe')
  })
  await page.waitForTimeout(2500)
  writeFileSync(join(OUT, file), await page.locator('#map').screenshot())
}

test('globe baseline — ocean_land artifacts', async ({ page }) => {
  test.setTimeout(60_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await shoot(page, '0.6/20/10', 'globe-whole.png')       // whole globe — inner sphere
  await shoot(page, '3/35/128', 'globe-coast-asia.png')   // coarse coast — tessellation gaps
  console.log('GLOBE_BASELINE errors=', errors.length, errors.slice(0, 3).join('|'))
})
