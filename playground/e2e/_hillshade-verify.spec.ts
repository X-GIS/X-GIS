import { test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

test('hillshade renders shaded relief from a raster-dem source', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1200, height: 700 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // Alps — terrarium DEM has real relief here.
  await page.goto('/demo.html?id=hillshade&e2e=1#6/46.5/9', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true, null, { timeout: 20_000 })
  await page.waitForTimeout(10000) // DEM tiles fetch from AWS terrarium (slow)

  const state = await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: Record<string, unknown> }).__xgisMap
    if (!m) return { noMap: true }
    const hr = m.hillshadeRenderer as Record<string, unknown> | null
    const cache = hr?.tileCache as Map<string, unknown> | undefined
    const loading = hr?.loadingTiles as Set<string> | Map<string, unknown> | undefined
    const visible = hr?.lastVisibleKeys as unknown[] | Set<unknown> | undefined
    return {
      tileCacheSize: cache instanceof Map ? cache.size : 'n/a',
      cacheKeys: cache instanceof Map ? [...cache.keys()].slice(0, 12) : 'n/a',
      loadingCount: loading instanceof Set ? loading.size : loading instanceof Map ? loading.size : 'n/a',
      visibleCount: Array.isArray(visible) ? visible.length : visible instanceof Set ? visible.size : 'n/a',
      visibleKeys: Array.isArray(visible) ? visible.slice(0, 12) : visible instanceof Set ? [...visible].slice(0, 12) : 'n/a',
    }
  })
  console.log('HILLSHADE_STATE:', JSON.stringify(state), 'errors=', errors.length, errors.slice(0, 2).join('|'))

  const png = await page.locator('#map').screenshot()
  writeFileSync(join(HERE, '__render-verify__', 'hillshade.png'), png)
})
