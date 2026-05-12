import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__geolines-render__')
mkdirSync(OUT, { recursive: true })

// Larger viewport for a clearer Tropic of Cancer / Equator capture
// at z=2-3 demotiles. User reports geolines-label is rendering at
// wrong color and halo missing, plus text-baseline sits above line
// instead of on it. Capture compare panes + zoom range probe.
for (const cfg of [
  { name: 'z1.5',  hash: '#1.5/20/0' },
  { name: 'z2',    hash: '#2.0/20/0' },
  { name: 'z3',    hash: '#3.0/22/0' },
  { name: 'z5',    hash: '#5.0/22/-30' },
  { name: 'z6',    hash: '#6.0/22/-30' },
]) {
  test(`geolines ${cfg.name}`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1800, height: 900 })
    await page.goto(`/compare.html?style=maplibre-demotiles${cfg.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean; __mlReady?: boolean })
        .__xgisReady === true
        && (window as unknown as { __mlReady?: boolean }).__mlReady === true,
      null, { timeout: 30_000 },
    )
    await page.waitForTimeout(8_000)
    const panes = page.locator('#panes .pane')
    const ml = await panes.nth(0).screenshot()
    const xg = await panes.nth(1).screenshot()
    writeFileSync(join(OUT, `${cfg.name}-ml.png`), ml)
    writeFileSync(join(OUT, `${cfg.name}-xg.png`), xg)
  })
}
