// Diagnostic spec for "browser hangs / OOMs during fast zoom on
// pmtiles live source".
//
// User report: opening pmtiles_layered against the live protomaps
// archive, then aggressively zooming, eventually locks the browser
// with no console output. Symptom signature suggests OS-level OOM
// rather than a render bug — main thread stays alive (no errors)
// but heap usage climbs until the process is killed.
//
// Approach: drive 50 fast zoom cycles between z=13 and z=16, sample
// the backend's internal collections + JS heap each cycle. Anything
// that grows monotonically is a leak suspect.
//
// Assertions are loose floors — this spec is for surfacing growth,
// not pinning a specific number. If a real leak exists, the
// suspect collection should grow much faster than the tolerance.

import { test, expect } from '@playwright/test'

interface BackendDiag {
  abortControllers: number
  pendingMvt: number
  failedKeys: number
  loadingTiles: number
  dataCacheSize: number
  prefetchKeys: number
  heapMB: number | null
}
interface XgisMap {
  vtSources: Map<string, { renderer: { source: unknown } }>
  camera: { zoom: number }
}
declare global {
  interface Window { __xgisMap?: XgisMap; __xgisReady?: boolean }
}

test.describe('PMTiles live: fast zoom should not leak backend state', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('50× zoom 13↔16 cycles: abortControllers + pendingMvt stay bounded', async ({ page }) => {
    test.setTimeout(180_000)

    await page.goto(
      `/demo.html?id=pmtiles_layered#13/35.68/139.76`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(
      () => window.__xgisReady === true,
      null, { timeout: 30_000 },
    )
    await page.waitForTimeout(3000)

    const sample = async (): Promise<BackendDiag> => {
      return await page.evaluate(() => {
        const map = window.__xgisMap
        // Reach into TS-private fields — runtime JS doesn't enforce
        // them. Diagnostics only; this stays in the spec, not in
        // production code.
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
        }
      })
    }

    const before = await sample()
    console.log('[before cycles]', before)

    // 50 rapid zoom cycles. Each cycle: zoom in, brief settle, zoom
    // out, brief settle. ~100 ms / step → ~10 s total. The brief
    // settle gives fetches a chance to start (so abort traffic
    // happens) but not enough to fully settle, mimicking a user
    // who pinches back-and-forth without pausing.
    for (let i = 0; i < 50; i++) {
      await page.evaluate(() => {
        window.__xgisMap!.camera.zoom = 16
      })
      await page.waitForTimeout(80)
      await page.evaluate(() => {
        window.__xgisMap!.camera.zoom = 13
      })
      await page.waitForTimeout(80)

      // Sample every 10th cycle to keep log volume manageable.
      if ((i + 1) % 10 === 0) {
        const s = await sample()
        console.log(`[cycle ${i + 1}]`, s)
      }
    }

    // Allow a final settle so any in-flight fetch can drain before
    // the post-measurement. Anything still pinned after this is a
    // genuine leak rather than transient activity.
    await page.waitForTimeout(5000)
    const after = await sample()
    console.log('[after cycles + settle]', after)

    // Bounded-growth assertions. The actual cap on each map is in
    // PMTilesBackend (MAX_INFLIGHT=16, MAX_CACHED_TILES via catalog).
    // We test against generous ceilings: anything above suggests a
    // collection that doesn't recover when transient state ends.
    expect(after.abortControllers).toBeLessThan(50)
    expect(after.pendingMvt).toBeLessThan(50)
    expect(after.loadingTiles).toBeLessThan(50)
    // dataCache has its own MAX_CACHED_TILES eviction; just verify
    // it didn't run away unboundedly.
    expect(after.dataCacheSize).toBeLessThan(2000)
    // failedKeys: bound by 5 min TTL × visible tiles + edge tiles.
    // Worst case ~hundreds, but a real leak would push much higher.
    expect(after.failedKeys).toBeLessThan(2000)

    // Heap: if Chromium reported it, growth past +500 MB suggests a
    // real leak. (Baseline pmtiles_layered runs at ~200 MB on
    // average viewports.)
    if (before.heapMB !== null && after.heapMB !== null) {
      const delta = after.heapMB - before.heapMB
      console.log(`[heap delta] ${delta} MB`)
      expect(delta).toBeLessThan(500)
    }
  })
})
