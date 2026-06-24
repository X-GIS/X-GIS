import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

type W = {
  __xgisReady?: boolean
  __xgisMap?: { setProjection?: (s: string) => void; setExperimentalGlobeDrape?: (b: boolean) => void; invalidate?: () => void }
}

// REAL opt-in path: map.setExperimentalGlobeDrape(true) (NOT the __xgisDebug flag)
// drapes vector content on NON-Mercator projections; Mercator keeps the direct
// path (option is a no-op there).
test('experimentalGlobeDrape: opt-in path on globe, no-op on mercator', async ({ page }) => {
  test.setTimeout(90_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.goto('/demo.html?id=pmtiles_layered&e2e=1#2.5/0/20', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, { timeout: 25_000 })
  await page.evaluate(() => {
    const w = window as unknown as W
    w.__xgisMap?.setProjection?.('globe')
    w.__xgisMap?.setExperimentalGlobeDrape?.(true)
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(9000)
  writeFileSync(join(OUT, 'realpath-globe.png'), await page.locator('#map').screenshot())

  // MERCATOR: the option must NOT engage the drape (flat keeps the direct path).
  await page.evaluate(() => {
    const w = window as unknown as W
    w.__xgisMap?.setProjection?.('mercator')
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(3000)
  writeFileSync(join(OUT, 'realpath-mercator.png'), await page.locator('#map').screenshot())

  // Drape engagement is verified by green-pixel coverage (post-run python):
  // globe shows the baked vector drape (green continents), mercator shows the
  // direct path (no green). Here just assert no GPU/page errors.
  console.log('REALPATH errors', errors.length)
  expect(errors.length).toBe(0)
})
