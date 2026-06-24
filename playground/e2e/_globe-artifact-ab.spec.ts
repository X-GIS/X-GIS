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

// Artifact A/B: direct globe vector (drape OFF) vs approach-B drape (drape ON) at
// the artifact-prone views — limb (inner-sphere / back-lip / tessellation gaps)
// and high-zoom over-zoom (jitter). Main context reads the PNGs + crops.
async function captureAB(page: import('@playwright/test').Page, hash: string, tag: string) {
  await page.goto(`/demo.html?id=pmtiles_layered&e2e=1#${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, { timeout: 25_000 })
  await page.evaluate(() => {
    const w = window as unknown as W
    w.__xgisMap?.setProjection?.('globe')
    w.__xgisMap?.setExperimentalGlobeDrape?.(false)
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(9000)
  writeFileSync(join(OUT, `art-${tag}-off.png`), await page.locator('#map').screenshot())
  await page.evaluate(() => {
    const w = window as unknown as W
    w.__xgisMap?.setExperimentalGlobeDrape?.(true)
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(6000)
  writeFileSync(join(OUT, `art-${tag}-on.png`), await page.locator('#map').screenshot())
}

test('artifact A/B: limb + high-zoom, drape off vs on', async ({ page }) => {
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1000, height: 1000 })

  await captureAB(page, '2.6/20/10', 'limb')      // whole globe — limb = silhouette edge
  await captureAB(page, '12/35.66/139.78', 'hz')   // Tokyo over-zoom — jitter
  console.log('ARTAB errors', errors.length)
})
