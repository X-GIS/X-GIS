// Captures user-reported scenarios as raw screenshots so we can
// VISUALLY inspect what's actually happening — not just compare
// against baselines.

import { test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

interface XgisMap {
  vtSources?: Map<string, { renderer: { _hysteresisZ?: number } }>
  camera?: { zoom: number; centerX: number; centerY: number; pitch?: number; bearing?: number }
}
declare global {
  interface Window { __xgisMap?: XgisMap; __xgisReady?: boolean }
}

const OUT_DIR = 'test-results/user-scenario-capture'

test.describe('User scenario capture', () => {
  test.use({ viewport: { width: 1500, height: 907 } })

  test('pmtiles_layered: world → Korea zoom-in sequence', async ({ page }) => {
    test.setTimeout(120_000)
    fs.mkdirSync(OUT_DIR, { recursive: true })

    // Capture at multiple camera states the user would actually see
    const states = [
      { name: '00-initial', hash: '' },
      { name: '01-zoom2-world', hash: '#2/0/0' },
      { name: '02-zoom5-asia', hash: '#5/35/127' },
      { name: '03-zoom8-korea', hash: '#8/37.5/127.5' },
      { name: '04-zoom10-seoul', hash: '#10/37.5665/126.978' },
      { name: '05-zoom13-seoul-zoomin', hash: '#13/37.5665/126.978' },
    ]

    for (const s of states) {
      const url = `/demo.html?id=pmtiles_layered${s.hash}`
      console.log('[capture]', s.name, url)
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.__xgisReady === true, null, { timeout: 30_000 })
      await page.waitForFunction(() => {
        const map = window.__xgisMap
        if (!map?.vtSources) return false
        for (const { renderer } of map.vtSources.values()) {
          if (typeof renderer._hysteresisZ === 'number' && renderer._hysteresisZ >= 0) return true
        }
        return false
      }, null, { timeout: 30_000 })
      await page.waitForTimeout(4000)
      const diag = await page.evaluate(() => {
        const map = window.__xgisMap!
        const out: { zoom: number; cz: number; visible: number; gpuTiles: number; catalogTiles: number; decisions: Record<string, number> } = {
          zoom: map.camera!.zoom,
          cz: -1, visible: 0, gpuTiles: 0, catalogTiles: 0, decisions: {},
        }
        for (const { renderer, source } of map.vtSources!.values() as IterableIterator<{
          renderer: { _hysteresisZ?: number; getDrawStats?: () => { tilesVisible: number }; gpuCache?: Map<string, Map<number, unknown>>; getLastDecisionCounts?: () => Record<string, number> },
          source: { dataCache?: Map<number, unknown> }
        }>) {
          out.cz = renderer._hysteresisZ ?? -1
          out.visible = renderer.getDrawStats?.().tilesVisible ?? 0
          if (renderer.gpuCache) {
            const inner = renderer.gpuCache.values().next().value
            if (inner) out.gpuTiles = inner.size
          }
          out.catalogTiles = source.dataCache?.size ?? 0
          if (renderer.getLastDecisionCounts) Object.assign(out.decisions, renderer.getLastDecisionCounts())
        }
        return out
      })
      console.log('[capture]', s.name, JSON.stringify(diag))
      const buf = await page.screenshot({ fullPage: false })
      fs.writeFileSync(path.join(OUT_DIR, `${s.name}.png`), buf)
    }

    // Mid-transition capture during zoom-in (the user-reported bug)
    console.log('[capture] zoom-in transition (Seoul z=10 → z=13)')
    await page.goto(`/demo.html?id=pmtiles_layered#10/37.5665/126.978`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__xgisReady === true, null, { timeout: 30_000 })
    await page.waitForTimeout(5000) // settle z=10
    fs.writeFileSync(path.join(OUT_DIR, '10-pre-zoomin.png'), await page.screenshot())
    // Trigger zoom-in
    await page.evaluate(() => { window.__xgisMap!.camera!.zoom = 13 })
    // Capture every 200ms for 3s during transition
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(200)
      const buf = await page.screenshot()
      fs.writeFileSync(path.join(OUT_DIR, `11-zoomin-${String(i).padStart(2, '0')}.png`), buf)
    }
    fs.writeFileSync(path.join(OUT_DIR, '12-post-zoomin.png'), await page.screenshot())
    console.log('[capture] done — see test-results/user-scenario-capture/')
  })
})
