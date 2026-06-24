import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

// PoC approach-B integration: MULTI-TILE drape. __xgisDebugMultiDrape bakes EVERY
// resident vector tile (composited layers) to a texture and drapes each over its
// true geo bounds on the globe — the real path replacing the direct vector draw.
// Equator-centred so BOTH northern and southern tiles are in view (exposes the
// known southern-tile drape anomaly). Visual gate = MAIN context reads the PNG.
test('multi-tile drape covers the globe (north + south)', async ({ page }) => {
  test.setTimeout(90_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.setViewportSize({ width: 1000, height: 1000 })
  // Globe, zoom ~2.5 centred on the equator (lon 20, lat 0) — Africa hemisphere,
  // north + south tiles both visible.
  await page.goto('/demo.html?id=pmtiles_layered&e2e=1#2.5/0/20', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 25_000 },
  )
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { setProjection?: (s: string) => void; invalidate?: () => void } }
    w.__xgisMap?.setProjection?.('globe')
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(6000)
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDebugMultiDrape?: boolean }
    w.__xgisDebugMultiDrape = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(3500)
  // PRODUCTION: drape hemisphere-cull on, no back leak — clean front globe.
  writeFileSync(join(OUT, 'multidrape-globe.png'), await page.locator('#map').screenshot())

  // BACK-FACE DEBUG: paint far-hemisphere drape fragments RED (cull is disabled
  // in this mode so the back is visible). Red = back-hemisphere drape content.
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDebugBackFace?: boolean }
    w.__xgisDebugBackFace = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(2000)
  writeFileSync(join(OUT, 'multidrape-backface.png'), await page.locator('#map').screenshot())

  console.log('multidrape errors =', errors.length, errors.slice(0, 4).join(' || '))
  expect(errors.length).toBe(0)
})
