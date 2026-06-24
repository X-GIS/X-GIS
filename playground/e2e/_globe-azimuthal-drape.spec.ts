import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

type W = {
  __xgisReady?: boolean
  __xgisMap?: { setProjection?: (s: string) => void; setExperimentalGlobeDrape?: (b: boolean) => void; invalidate?: () => void }
}

// US-004: the drape gate includes the flat azimuthal family (projType 3/4/5).
// Verify each renders the baked drape (not just globe=7).
test('drape on flat azimuthal: ortho / azimuthal / stereographic', async ({ page }) => {
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.goto('/demo.html?id=pmtiles_layered&e2e=1#2.2/20/10', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, { timeout: 25_000 })
  await page.evaluate(() => {
    const w = window as unknown as W
    w.__xgisMap?.setExperimentalGlobeDrape?.(true)
  })

  for (const proj of ['orthographic', 'azimuthal_equidistant', 'stereographic']) {
    await page.evaluate((p) => {
      const w = window as unknown as W
      w.__xgisMap?.setProjection?.(p)
      w.__xgisMap?.invalidate?.()
    }, proj)
    await page.waitForTimeout(7000)
    writeFileSync(join(OUT, `az-${proj}.png`), await page.locator('#map').screenshot())
  }
  console.log('AZDRAPE errors', errors.length)
})
