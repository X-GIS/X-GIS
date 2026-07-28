// Tile-SELECTION A/B at the reported OFM Liberty camera, X-GIS vs MapLibre.
//
// The frame-drop + permanent-[FLICKER] report at
// #16.00/51.50466/-0.11813/60.0/72.4 bottoms out in
// `getTileLoadDiagnostic()` reporting needed=899 against gpuCap=256: the
// camera asks for 3.5x more tiles than the GPU cache can hold, so eviction
// churns every frame and `missed` never reaches 0.
//
// Tile selection is pure CPU, so unlike frame timing it is measurable here and
// backend-independent. MapLibre renders this same camera fine, and its
// `coveringTiles` drops zoom with distance (a near-horizon frustum gets coarse
// tiles far away). This probe asks BOTH engines what they selected, and
// reports the per-zoom histogram, so an LOD gap shows up as X-GIS holding a
// flat z-distribution where MapLibre tapers.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installOfflineProxy } from './helpers/offline-proxy'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__debug-liberty-pitch72__')
mkdirSync(OUT, { recursive: true })

const PITCHES = (process.env.TC_PITCHES ?? '0,30,50,60,72.4').split(',')
const BASE = process.env.TC_BASE ?? '16.00/51.50466/-0.11813/60.0'

for (const pitch of PITCHES) {
  test(`tile-count A/B pitch ${pitch}`, async ({ page }) => {
    test.setTimeout(240_000)
    await installOfflineProxy(page, { cacheDir: join(HERE, '__net-cache__') })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/compare.html?style=openfreemap-liberty#${BASE}/${pitch}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
        return w.__xgisReady === true && w.__mlReady === true
      },
      null,
      { timeout: 120_000 },
    )
    await page.waitForTimeout(10_000)

    const result = await page.evaluate(() => {
      interface XM {
        getTileLoadDiagnostic: () => Record<string, Record<string, number>>
      }
      interface MLSourceCache {
        getVisibleCoordinates?: () => { canonical: { z: number } }[]
      }
      interface MLMap {
        style?: { sourceCaches?: Record<string, MLSourceCache> }
      }
      const xg = (window as unknown as { __xgisMap: XM }).__xgisMap
      const ml = (window as unknown as { __mlMap: MLMap }).__mlMap

      // MapLibre: per-source visible tile coords → per-zoom histogram.
      const mlByZoom: Record<string, Record<number, number>> = {}
      let mlTotal = 0
      const caches = ml?.style?.sourceCaches ?? {}
      for (const name of Object.keys(caches)) {
        const coords = caches[name]?.getVisibleCoordinates?.() ?? []
        const h: Record<number, number> = {}
        for (const c of coords) h[c.canonical.z] = (h[c.canonical.z] ?? 0) + 1
        mlByZoom[name] = h
        mlTotal += coords.length
      }
      return { xgis: xg.getTileLoadDiagnostic(), mlByZoom, mlTotal }
    })

    const xgVec = result.xgis['openmaptiles']
    const mlVec = result.mlByZoom['openmaptiles'] ?? {}
    const mlVecTotal = Object.values(mlVec).reduce((a, b) => a + b, 0)
    const row = {
      pitch,
      xgisNeeded: xgVec?.needed,
      xgisMissed: xgVec?.missed,
      xgisGpuUnique: xgVec?.gpuUnique,
      xgisGpuCap: xgVec?.gpuCap,
      maplibreVisible: mlVecTotal,
      maplibrePerZoom: mlVec,
      ratio: mlVecTotal > 0 ? +((xgVec?.needed ?? 0) / mlVecTotal).toFixed(1) : null,
    }
    writeFileSync(join(OUT, `tilecount-p${pitch}.json`), JSON.stringify(row, null, 2))
    console.warn('[tilecount]', JSON.stringify(row))
    expect(xgVec).toBeTruthy()
  })
}
