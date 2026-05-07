// Captures the new OSM-style PMTiles demo at multiple cities to
// verify the per-kind filtered layers produce the expected
// cartographic rendering.

import { test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const OUT_DIR = 'test-results/osm-style-capture'

interface XgisMap {
  vtSources?: Map<string, { renderer: { _hysteresisZ?: number; getDrawStats?: () => { tilesVisible: number } } }>
  camera?: { zoom: number }
}
declare global {
  interface Window { __xgisMap?: XgisMap; __xgisReady?: boolean }
}

test.describe('OSM-style demo capture', () => {
  test.use({ viewport: { width: 1500, height: 907 } })

  test('osm_style: world / city / detail captures', async ({ page }) => {
    test.setTimeout(120_000)
    fs.mkdirSync(OUT_DIR, { recursive: true })

    const states = [
      { name: '00-zoom2-world', hash: '#2/0/0' },
      { name: '01-tokyo-z14', hash: '#14/35.68/139.76' },
      { name: '02-manhattan-z14', hash: '#14/40.78/-73.97' },
      { name: '03-seoul-z13', hash: '#13/37.5665/126.978' },
      // Tilted views — verify 3D building extrusion is visible.
      { name: '04-tokyo-z16-tilt45', hash: '#16/35.68/139.76/0/45' },
      { name: '05-manhattan-z16-tilt60', hash: '#16/40.78/-73.97/0/60' },
      { name: '06-manhattan-z17-tilt75', hash: '#17/40.7580/-73.9855/0/75' },
      // User-reported "lake below ground" — Tokyo Imperial Palace
      // moat at z=16.64 / pitch=50.6° / bearing=47.5°.
      { name: '07-tokyo-moat-bug', hash: '#16.64/35.71214/139.76923/47.5/50.6' },
      { name: '08-tokyo-moat-topdown', hash: '#16.42/35.71253/139.76863/67.2/0.0' },
    ]

    for (const s of states) {
      const url = `/demo.html?id=osm_style${s.hash}`
      console.log('[osm-capture]', s.name, url)
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.__xgisReady === true, null, { timeout: 30_000 })
      await page.waitForTimeout(5000) // settle PMTiles fetch
      const buf = await page.screenshot()
      fs.writeFileSync(path.join(OUT_DIR, `${s.name}.png`), buf)
    }
    console.log('[osm-capture] done — see test-results/osm-style-capture/')
  })
})
