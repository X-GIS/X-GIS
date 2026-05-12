import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__zoom-in-dup__')
mkdirSync(OUT, { recursive: true })

// Reproduce label-duplication-on-zoom-in regression reported
// 2026-05-12. The cross-tile dedupe fix landed for the static
// load case at z=17.93 Seoul. User says zooming in re-creates
// the duplication, so sweep zoom levels around the original
// case and a separate dense-label scene.
for (const cfg of [
  { name: 'seoul-z17',    hash: '#17/37.12661/126.92401' },
  { name: 'seoul-z18',    hash: '#18/37.12661/126.92401' },
  { name: 'seoul-z19',    hash: '#19/37.12661/126.92401' },
  { name: 'manhattan-z16', hash: '#16/40.7589/-73.9851' },
  { name: 'manhattan-z18', hash: '#18/40.7589/-73.9851' },
  { name: 'tokyo-z16',     hash: '#16/35.6762/139.6503' },
  { name: 'tokyo-z18',     hash: '#18/35.6762/139.6503' },
]) {
  test(`zoom-in-dup ${cfg.name}`, async ({ page }) => {
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
    await page.waitForTimeout(10_000)
    const panes = page.locator('#panes .pane')
    const ml = await panes.nth(0).screenshot()
    const xg = await panes.nth(1).screenshot()
    writeFileSync(join(OUT, `${cfg.name}-ml.png`), ml)
    writeFileSync(join(OUT, `${cfg.name}-xg.png`), xg)
  })
}
