// London Eye pitch sweep — the wheel is an open RING (rim segments + thin
// spokes + hub). Seen from a low pitch its interior must read as EMPTY;
// anything that fills the disc is a bug.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { installOfflineProxy } from './helpers/offline-proxy'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__debug-london-eye-pitch__')
mkdirSync(OUT, { recursive: true })

const STYLE = process.env.EYE_STYLE ?? 'liberty-buildings-only'
const ZOOM = process.env.EYE_ZOOM ?? '17'
const BEARING = process.env.EYE_BEARING ?? '0'
const PITCHES = (process.env.EYE_PITCHES ?? '0,15,30,45,60').split(',')

for (const pitch of PITCHES) {
  test(`eye pitch ${pitch}`, async ({ page }) => {
    test.setTimeout(240_000)
    page.on('console', (m) => {
      const t = m.text()
      if (m.type() === 'error' || /X-GIS|arena|oom|extrude|skip|warn/i.test(t))
        console.warn(`[page:${m.type()}]`, t.slice(0, 400))
    })
    await installOfflineProxy(page, { cacheDir: join(HERE, '__net-cache__') })
    await page.setViewportSize({ width: 1000, height: 800 })
    const hash = `#${ZOOM}/51.50332/-0.11954/${BEARING}/${pitch}`
    await page.goto(`/compare.html?style=${STYLE}${hash}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
        return w.__xgisReady === true && w.__mlReady === true
      },
      null,
      { timeout: 120_000 },
    )
    await page.waitForTimeout(15_000)
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    )
    const dir = join(OUT, `z${ZOOM}-b${BEARING}-p${pitch}`)
    mkdirSync(dir, { recursive: true })
    const mlPng = await page.locator('#ml-map canvas').first().screenshot()
    const xgPng = await page.locator('#xg-canv').screenshot()
    writeFileSync(join(dir, 'maplibre.png'), mlPng)
    writeFileSync(join(dir, 'xgis.png'), xgPng)
    expect(PNG.sync.read(mlPng).width).toBeGreaterThan(0)
    console.warn(`[eye pitch ${pitch}] → ${dir}`)
  })
}
