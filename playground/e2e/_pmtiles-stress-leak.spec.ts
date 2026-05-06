// Stress test: jump across the world while zooming. Maxes out
// archive directory walks (each new region needs new directory
// pages from the PMTiles archive), exercises tile cancellation
// (camera moves before fetches finish), and stresses the worker
// pool (decode pressure as new region tiles arrive).
//
// Goal: reproduce the user-reported "OOM / browser hang during
// fast zoom on pmtiles live source". The diagnostic
// _pmtiles-rapid-zoom-leak.spec.ts in the same directory exercises
// only single-location zoom and showed no leak — this spec adds
// world-scale pan to stress directory caching + archive.getZxy
// concurrency.

import { test, expect } from '@playwright/test'

interface BackendDiag {
  abortControllers: number
  pendingMvt: number
  failedKeys: number
  loadingTiles: number
  dataCacheSize: number
  prefetchKeys: number
  heapMB: number | null
  cycleMs: number
}
interface XgisCamera { centerX: number; centerY: number; zoom: number }
interface XgisMap {
  vtSources: Map<string, { renderer: { source: unknown } }>
  camera: XgisCamera
}
declare global {
  interface Window { __xgisMap?: XgisMap; __xgisReady?: boolean }
}

// World cities — well-spread coordinates so each jump triggers
// directory pages the archive hasn't seen recently.
const CITIES: Array<[string, number, number]> = [
  ['Tokyo',     35.6762, 139.6503],
  ['New York',  40.7128, -74.0060],
  ['London',    51.5074,  -0.1278],
  ['Sydney',   -33.8688, 151.2093],
  ['Sao Paulo',-23.5505, -46.6333],
  ['Cairo',     30.0444,  31.2357],
  ['Mumbai',    19.0760,  72.8777],
  ['Cape Town',-33.9249,  18.4241],
]

test.describe('PMTiles live: world-scale pan + zoom stress', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('100× city jump + zoom: bounded growth in heap and backend collections', async ({ page }) => {
    test.setTimeout(360_000)

    await page.goto(
      `/demo.html?id=pmtiles_layered#13/${CITIES[0][1]}/${CITIES[0][2]}`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(
      () => window.__xgisReady === true,
      null, { timeout: 30_000 },
    )
    await page.waitForTimeout(3000)

    const sample = async (cycleMs: number): Promise<BackendDiag> => {
      return await page.evaluate((cms) => {
        const map = window.__xgisMap
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const renderer = [...(map?.vtSources?.values() ?? [])][0]?.renderer as any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const catalog = renderer?.source as any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const backend = catalog?.backends?.[0] as any
        const heap = (performance as unknown as {
          memory?: { usedJSHeapSize: number }
        }).memory
        return {
          abortControllers: backend?.abortControllers?.size ?? -1,
          pendingMvt: backend?.pendingMvt?.length ?? -1,
          failedKeys: backend?.failedKeys?.size ?? -1,
          loadingTiles: catalog?.loadingTiles?.size ?? -1,
          dataCacheSize: catalog?.dataCache?.size ?? -1,
          prefetchKeys: catalog?._prefetchKeys?.size ?? -1,
          heapMB: heap ? Math.round(heap.usedJSHeapSize / 1024 / 1024) : null,
          cycleMs: cms,
        }
      }, cycleMs)
    }

    const before = await sample(0)
    console.log('[before stress]', before)

    const tStart = Date.now()
    let prevCycleEnd = tStart

    for (let i = 0; i < 100; i++) {
      const [city, lat, lon] = CITIES[i % CITIES.length]
      // Pick a zoom in [13, 17). Each cycle alternates a "wide"
      // and "deep" zoom so we hit different LOD ranges per city.
      const zoom = 13 + (i % 5)

      await page.evaluate(({ lat, lon, zoom }) => {
        // Inline lon/lat → web-mercator conversion. Same formula
        // used internally by lonLatToMercF64 — keeping it here
        // avoids reaching into the runtime's util exports from a
        // page.evaluate context.
        const R = 6378137
        const mx = lon * Math.PI / 180 * R
        const lat2 = Math.max(-85.0511, Math.min(85.0511, lat))
        const my = Math.log(Math.tan(Math.PI / 4 + lat2 * Math.PI / 360)) * R
        const map = window.__xgisMap!
        map.camera.centerX = mx
        map.camera.centerY = my
        map.camera.zoom = zoom
      }, { lat, lon, zoom })
      // Settle window — long enough for some fetches to start, not
      // long enough for them all to complete. This is the regime
      // where leaks would surface.
      await page.waitForTimeout(150)

      if ((i + 1) % 10 === 0) {
        const now = Date.now()
        const cycleMs = (now - prevCycleEnd) / 10
        prevCycleEnd = now
        const s = await sample(cycleMs)
        console.log(`[cycle ${i + 1} → ${city}@z${zoom}]`, s)
      }
    }

    // Extended settle so any in-flight fetch can drain.
    await page.waitForTimeout(10_000)
    const after = await sample(0)
    console.log('[after stress + settle]', after)

    // Bounded-growth assertions. Larger ceilings than the simpler
    // diagnostic spec because the world-scale traversal warms the
    // archive's per-region caches.
    expect(after.abortControllers).toBeLessThan(100)
    expect(after.pendingMvt).toBeLessThan(100)
    expect(after.loadingTiles).toBeLessThan(100)
    expect(after.dataCacheSize).toBeLessThan(3000)
    expect(after.failedKeys).toBeLessThan(3000)

    if (before.heapMB !== null && after.heapMB !== null) {
      const delta = after.heapMB - before.heapMB
      console.log(`[heap delta] ${delta} MB`)
      // 1 GB headroom — anything beyond suggests a real leak.
      expect(delta).toBeLessThan(1000)
    }
  })
})
