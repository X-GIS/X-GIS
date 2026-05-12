import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__zoomstep__')
mkdirSync(OUT, { recursive: true })

// Probe label visibility at fractional zooms near integer boundaries.
//
// IMPORTANT: capture the PANE bounding-box (CSS px), not the canvas
// element directly. MapLibre canvas screenshot returns CSS px; X-GIS
// canvas screenshot returns DPR-scaled buffer px. Capturing the wrapper
// `.pane` div gives both engines the SAME px dimensions, so geographic
// extents line up and label-count comparisons are valid.
for (const cfg of [
  { name: 'ofm-z4.5', style: 'openfreemap-bright', hash: '#4.5/40/0' },
  { name: 'ofm-z5', style: 'openfreemap-bright', hash: '#5/40/0' },
  { name: 'ofm-z7.5', style: 'openfreemap-bright', hash: '#7.5/40.7/-74' },
  { name: 'ofm-z8', style: 'openfreemap-bright', hash: '#8/40.7/-74' },
  { name: 'ofm-z11.5', style: 'openfreemap-bright', hash: '#11.5/40.755/-73.985' },
  { name: 'ofm-z12', style: 'openfreemap-bright', hash: '#12/40.755/-73.985' },
]) {
  test(`zoomstep ${cfg.name}`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1200, height: 700 })
    await page.goto(`/compare.html?style=${cfg.style}${cfg.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean; __mlReady?: boolean })
        .__xgisReady === true
        && (window as unknown as { __mlReady?: boolean }).__mlReady === true,
      null, { timeout: 30_000 },
    )
    // Give both engines time to load+place labels at this camera.
    await page.waitForTimeout(8000)
    const panes = page.locator('#panes .pane')
    const ml = await panes.nth(0).screenshot()
    const xg = await panes.nth(1).screenshot()
    writeFileSync(join(OUT, `${cfg.name}-ml.png`), ml)
    writeFileSync(join(OUT, `${cfg.name}-xg.png`), xg)
  })
}
