import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

// PoC S1 gate: a checkerboard texture draped on the globe front hemisphere via
// raster-renderer.drawDrape must WARP along the sphere (curved cells, not a flat
// screen-space rectangle). coastline demo = line-only so no fill covers it.
test('globe drape S1 — checkerboard warps on sphere', async ({ page }) => {
  test.setTimeout(60_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.goto('/demo.html?id=coastline&e2e=1#0.7/15/10', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true, null, { timeout: 20_000 })
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { setProjection?: (p: string) => void; invalidate?: () => void }; __xgisDebugDrape?: boolean }
    w.__xgisMap?.setProjection?.('globe')
    w.__xgisDebugDrape = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(2500)
  writeFileSync(join(OUT, 'drape-s1.png'), await page.locator('#map').screenshot())
  console.log('DRAPE_S1 errors=', errors.length, errors.slice(0, 3).join('|'))
})
