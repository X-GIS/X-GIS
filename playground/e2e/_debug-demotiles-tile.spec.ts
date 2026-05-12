import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__demotiles-tile__')
mkdirSync(OUT, { recursive: true })

// User-reported 2026-05-12: demotiles z=2.00 shows tiling artifacts.
// Also sweep a few neighbouring zooms / OFM at the same camera for
// contrast.
for (const cfg of [
  { name: 'demotiles-z2',     style: 'maplibre-demotiles',   hash: '#2.00/20.0/0.0' },
  { name: 'demotiles-z2.5',   style: 'maplibre-demotiles',   hash: '#2.50/20.0/0.0' },
  { name: 'demotiles-z3',     style: 'maplibre-demotiles',   hash: '#3.00/20.0/0.0' },
  { name: 'demotiles-z1.5',   style: 'maplibre-demotiles',   hash: '#1.50/20.0/0.0' },
  { name: 'ofm-z2',           style: 'openfreemap-bright',   hash: '#2.00/20.0/0.0' },
]) {
  test(`demotiles-tile ${cfg.name}`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1400, height: 800 })
    await page.goto(`/compare.html?style=${cfg.style}${cfg.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean; __mlReady?: boolean })
        .__xgisReady === true
        && (window as unknown as { __mlReady?: boolean }).__mlReady === true,
      null, { timeout: 30_000 },
    )
    await page.waitForTimeout(10_000)
    const panes = page.locator('#panes .pane')
    const ml = await panes.nth(0).screenshot()
    const xg = await panes.nth(1).screenshot()
    writeFileSync(join(OUT, `${cfg.name}-ml.png`), ml)
    writeFileSync(join(OUT, `${cfg.name}-xg.png`), xg)
  })
}
