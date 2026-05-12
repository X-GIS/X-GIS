import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__label-bugs__')
mkdirSync(OUT, { recursive: true })

// Capture specific scenarios reported by user 2026-05-12:
//   #1 slash-in-label newline bug         → Tokyo z=12 (Japanese name/Roman name)
//   #2 label anchor end-vs-center         → world cities z=3-6
//   #3 lines/fills one tile late          → boundary fade z=5..6
//   #4 water label color (blue→black)     → ocean z=1..3
//   #5 halo too thick / text too thin     → close-up dense labels
//   #6 antimeridian z=0 right-edge labels → world z=0
for (const cfg of [
  { name: '1-slash-tokyo-z12',   hash: '#12/35.68/139.76' },
  { name: '1-slash-seoul-z11',   hash: '#11/37.5665/126.9780' },
  { name: '2-anchor-world-z3',   hash: '#3/30/0' },
  { name: '2-anchor-asia-z4',    hash: '#4/35/120' },
  { name: '4-water-world-z2',    hash: '#2/15/30' },
  { name: '4-water-atlantic-z3', hash: '#3/30/-40' },
  { name: '5-halo-paris-z14',    hash: '#14/48.8566/2.3522' },
  { name: '6-antimeridian-z0',   hash: '#0/0/180' },
  { name: '6-antimeridian-z1',   hash: '#1/0/180' },
]) {
  test(`label-bug ${cfg.name}`, async ({ page }) => {
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
