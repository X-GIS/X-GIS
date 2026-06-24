import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

// PoC S2 (bake) + S3 (drape) gate. __xgisDebugBakeDrape bakes the first non-empty
// vector tile to a texture (solid green) and drapes it over its geo bounds.
// FLAT = S2 gate (baked silhouette matches the tile polygons). GLOBE = S3 gate
// (baked content warps on the sphere).
async function shoot(page: import('@playwright/test').Page, proj: string, hash: string, file: string) {
  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.goto(`/demo.html?id=ocean_land&e2e=1#${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true, null, { timeout: 20_000 })
  await page.evaluate((p) => {
    const w = window as unknown as { __xgisMap?: { setProjection?: (s: string) => void; invalidate?: () => void }; __xgisDebugBakeDrape?: boolean }
    if (p === 'globe') w.__xgisMap?.setProjection?.('globe')
    w.__xgisDebugBakeDrape = true
    w.__xgisMap?.invalidate?.()
  }, proj)
  await page.waitForTimeout(3000)
  writeFileSync(join(OUT, file), await page.locator('#map').screenshot())
}

test('bake+drape S2/S3', async ({ page }) => {
  test.setTimeout(70_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await shoot(page, 'flat', '2/30/20', 'bakedrape-flat.png')
  await shoot(page, 'globe', '0.7/20/10', 'bakedrape-globe.png')
  console.log('BAKEDRAPE errors=', errors.length, errors.slice(0, 4).join(' || '))
})
