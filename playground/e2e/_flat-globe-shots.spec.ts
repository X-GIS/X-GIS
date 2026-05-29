import { test } from '@playwright/test'
import { mkdirSync } from 'fs'

// Manual capture (leading `_` opts out of smoke): renders a world-scale demo
// in each projection and saves a PNG, so the projection-display-layer-restore
// work can be confirmed visually (flat 2D forms vs the 3D globe).
//   bunx playwright test _flat-globe-shots.spec.ts --workers=1

const OUT = 'D:/X-GIS/.omc/shots'
mkdirSync(OUT, { recursive: true })

const PROJECTIONS = [
  'mercator', 'equirectangular', 'natural_earth',
  'orthographic', 'azimuthal_equidistant', 'stereographic', 'globe',
]

const waitFrames = (page: import('@playwright/test').Page) =>
  page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

// Wait until at least one vector-tile source reports visible tiles, so the
// capture isn't taken on an empty (still-loading) frame.
const waitTiles = (page: import('@playwright/test').Page) =>
  page.waitForFunction(() => {
    const m = (window as any).__xgisMap
    if (!m?.vtSources) return false
    for (const s of m.vtSources.values()) {
      const st = s.renderer?.getDrawStats?.()
      if (st && st.tilesVisible > 0) return true
    }
    return false
  }, null, { timeout: 15_000 }).catch(() => { /* still emit whatever painted */ })

test.use({ viewport: { width: 860, height: 860 } })

test('capture each projection (flat forms + globe)', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/demo.html?id=physical_map#2/20/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 30_000 })

  for (const proj of PROJECTIONS) {
    await page.evaluate((p) => (window as any).__xgisMap.setProjection(p), proj)
    await waitTiles(page)
    await page.waitForTimeout(700)
    await waitFrames(page)
    await page.locator('#map').screenshot({ path: `${OUT}/proj-${proj}.png` })
  }
})
