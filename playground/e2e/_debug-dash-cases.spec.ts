import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__dash-cases__')
mkdirSync(OUT, { recursive: true })

// OFM Bright has dasharray on: boundary_3 (admin), boundary_disputed,
// waterway intermittent, tunnel casings, railway hatching, bridge
// casings, highway-path, cablecar-dash. Sweep representative scenes.
for (const cfg of [
  { name: 'admin-boundary-z6',  hash: '#6/47.0/8.5' },        // alps, admin/country lines
  { name: 'tunnel-z14',          hash: '#14/40.7589/-73.9851' }, // manhattan tunnels
  { name: 'railway-z13',         hash: '#13/35.658/139.701' },   // tokyo rail hatching
  { name: 'bridge-z14',          hash: '#14/40.7060/-73.9969' }, // brooklyn bridge
  { name: 'waterway-z12',        hash: '#12/41.36/-72.10' },     // CT intermittent streams
]) {
  test(`dash-case ${cfg.name}`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1400, height: 800 })
    await page.goto(`/compare.html?style=openfreemap-bright${cfg.hash}`, {
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
