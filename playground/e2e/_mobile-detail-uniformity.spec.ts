// Reproduces the user-reported "detail unevenness" — at flat pitch
// on a mobile viewport, the canvas fills (no black gaps) but a
// stripe of the canvas renders at z=currentZ-1 instead of currentZ
// because catalog cache holds only some of the visible tiles, the
// rest fall back to the parent walk.
//
// Real-device inspector report (Tokyo z=11.52, mobile, post-fix):
//   visible expected at z=12   : 12 tiles
//   catalog cache @ z=12       : 3 tiles (only 1/4)
//   drawn z=12                 : 12 entries (3 unique × 4 layers)
//   drawn z=11 (parent fallback): 20 entries (5 unique × 4 layers)
//   fetch starts (post-install): 0
//   idle                       : 2732 ms
//
// Expected behaviour: after >5 s of idle, every visible tile at
// currentZ should be cached so the entire canvas renders at the
// camera's intended LOD with no parent-walk fallback.

import { test, expect } from '@playwright/test'

interface VTRDiag {
  _hysteresisZ?: number
  _frameTileCache?: { tiles?: { z: number; x: number; y: number }[] }
}
interface XGISMap {
  vtSources?: Map<string, { renderer: VTRDiag & { source: unknown } }>
  camera?: { zoom: number; centerX: number; centerY: number; pitch?: number }
}
declare global {
  interface Window { __xgisMap?: XGISMap; __xgisReady?: boolean }
}

test.describe('Mobile detail uniformity', () => {
  test.use({ viewport: { width: 430, height: 715 } })

  test('Tokyo z=11.52 flat pitch: all visible tiles cached after settle', async ({ page }) => {
    test.setTimeout(60_000)

    // Fetch counter telemetry — wraps backend.loadTile + cancelStale
    // BEFORE the runtime constructs them, so every call from page-load
    // through settle is counted.
    await page.addInitScript(() => {
      const w = window as unknown as { __DBG_FETCH_COUNTS: {
        starts: number; aborts: number; reqCalls: number; reqKeys: number; loadTileCalls: number
      } }
      w.__DBG_FETCH_COUNTS = { starts: 0, aborts: 0, reqCalls: 0, reqKeys: 0, loadTileCalls: 0 }
      const orig = AbortController.prototype.abort
      AbortController.prototype.abort = function patched(...args: unknown[]) {
        w.__DBG_FETCH_COUNTS.aborts++
        return orig.apply(this, args as [])
      }
      // Wait for the runtime to mount, then patch catalog +
      // backend hot-paths. Polls every 100ms for up to 5s.
      const installPatches = (): boolean => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const map = (window as any).__xgisMap
        if (!map?.vtSources) return false
        for (const { renderer } of map.vtSources.values()) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cat = (renderer as any).source as any
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (cat && !cat.__patched) {
            cat.__patched = true
            const origReq = cat.requestTiles.bind(cat)
            cat.requestTiles = (keys: number[]) => {
              w.__DBG_FETCH_COUNTS.reqCalls++
              w.__DBG_FETCH_COUNTS.reqKeys += keys.length
              return origReq(keys)
            }
            const backend = cat.backends?.[0]
            if (backend) {
              const origLoad = backend.loadTile.bind(backend)
              backend.loadTile = (k: number) => {
                w.__DBG_FETCH_COUNTS.loadTileCalls++
                const before = backend.abortControllers?.size ?? 0
                origLoad(k)
                const after = backend.abortControllers?.size ?? 0
                if (after > before) w.__DBG_FETCH_COUNTS.starts++
              }
            }
          }
        }
        return true
      }
      let tries = 0
      const id = setInterval(() => {
        if (installPatches() || tries++ > 50) clearInterval(id)
      }, 100)
    })

    await page.goto(
      `/demo.html?id=pmtiles_layered#11.52/35.7553/139.6973/0/0`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(
      () => window.__xgisReady === true,
      null, { timeout: 30_000 },
    )
    await page.waitForFunction(() => {
      const map = window.__xgisMap
      if (!map?.vtSources) return false
      let v = 0
      for (const { renderer } of map.vtSources.values()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        v += (renderer as any).getDrawStats?.().tilesVisible ?? 0
      }
      return v > 0
    }, null, { timeout: 60_000 })

    // Generous settle window — the symptom is that fetch stops
    // partway through the visible set, so 10 s should be far past
    // any reasonable cold-start.
    await page.waitForTimeout(10_000)

    const result = await page.evaluate(() => {
      const map = window.__xgisMap
      if (!map?.vtSources) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = [...map.vtSources.values()][0]?.renderer as any
      const cz = r._hysteresisZ as number
      const cache = r._frameTileCache
      const visible = (cache?.tiles ?? []) as { z: number; x: number; y: number }[]
      // Catalog dataCache is a Map<number, Map<string, TileData>>.
      // Sample one slot to read tileZoom (every slice in the slot
      // has the same key so same zoom).
      const dc = r.source?.dataCache as Map<number, Map<string, { tileZoom?: number }>> | undefined
      const cachedKeys = new Set<number>(dc?.keys?.() ?? [])
      const cachedByZ = new Map<number, number>()
      if (dc) {
        for (const slot of dc.values()) {
          const first = slot.values().next().value as { tileZoom?: number } | undefined
          if (first?.tileZoom !== undefined) {
            cachedByZ.set(first.tileZoom, (cachedByZ.get(first.tileZoom) ?? 0) + 1)
          }
        }
      }
      // Build tileKey-encoded lookup the same way the runtime does
      // (4^z + morton(x,y)) so we can ask "is this visible key in
      // the catalog?". Inline morton for 22-bit coords.
      function morton(x: number, y: number): number {
        let m = 0
        for (let i = 0; i < 22; i++) {
          m |= ((x >> i) & 1) << (2 * i)
          m |= ((y >> i) & 1) << (2 * i + 1)
        }
        return m
      }
      function tileKey(z: number, x: number, y: number): number {
        return Math.pow(4, z) + morton(x, y)
      }
      const visibleAtCurrentZ = visible.filter(t => t.z === cz)
      const cachedVisibleAtCurrentZ = visibleAtCurrentZ.filter(t => cachedKeys.has(tileKey(t.z, t.x, t.y)))
      const missingAtCurrentZ = visibleAtCurrentZ.filter(t => !cachedKeys.has(tileKey(t.z, t.x, t.y)))
      // Backend in-flight + queue state
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const backend = (r.source as any)?.backends?.[0] as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cat = r.source as any
      return {
        currentZ: cz,
        visibleTotal: visible.length,
        visibleAtCurrentZ: visibleAtCurrentZ.length,
        cachedVisibleAtCurrentZ: cachedVisibleAtCurrentZ.length,
        missingAtCurrentZ: missingAtCurrentZ.length,
        missingKeys: missingAtCurrentZ.map(t => `${t.z}/${t.x}/${t.y}`),
        cachedByZ: Object.fromEntries(cachedByZ),
        cachedTotal: cachedKeys.size,
        loadingTiles: cat?.loadingTiles?.size ?? -1,
        abortControllers: backend?.abortControllers?.size ?? -1,
        pendingMvt: backend?.pendingMvt?.length ?? -1,
        prefetchKeys: cat?._prefetchKeys?.size ?? -1,
        evictShield: cat?._evictShield?.size ?? -1,
      }
    })

    if (!result) throw new Error('no map')
    // After-the-fact instrumentation of backend.loadTile + acceptResult
    // to count fetch starts and the dispositions (cached vs failed).
    const fetchStats = await page.evaluate(() => {
      const map = window.__xgisMap
      if (!map?.vtSources) return null
      const out: { starts: number; settled: number; aborts: number; failed: number; activeNow: number } = {
        starts: 0, settled: 0, aborts: 0, failed: 0, activeNow: 0,
      }
      for (const { renderer } of map.vtSources.values()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = renderer as any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cat = r.source as any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const backend = cat?.backends?.[0] as any
        if (backend) {
          // History counters (we never reset them, so they accumulate
          // across the full lifetime of this page load).
          out.activeNow = backend.abortControllers?.size ?? -1
          // Read the failedKeys size + dataCache.size to derive
          // dispositions.
          out.failed = backend.failedKeys?.size ?? 0
        }
        if (cat) {
          out.settled = cat.dataCache?.size ?? 0
        }
      }
      return out
    })
    const counts = await page.evaluate(() => (window as unknown as { __DBG_FETCH_COUNTS: { starts: number; aborts: number; reqCalls: number; reqKeys: number; loadTileCalls: number } }).__DBG_FETCH_COUNTS)
    const installState = await page.evaluate(() => {
      const map = window.__xgisMap
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cat = (map?.vtSources?.values().next().value as any)?.renderer?.source
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const backend = cat?.backends?.[0]
      return {
        catPatched: !!cat?.__patched,
        // requestTiles refs equal? (sanity: same fn after patch)
        reqType: typeof cat?.requestTiles,
        loadTileType: typeof backend?.loadTile,
      }
    })
    console.log('[install state]', installState)
    console.log('[counts]', counts)
    console.log('[fetch stats]', fetchStats)
    console.log('[currentZ]', result.currentZ)
    console.log('[visible]', `total=${result.visibleTotal}`,
      `at currentZ=${result.visibleAtCurrentZ}`,
      `cached at currentZ=${result.cachedVisibleAtCurrentZ}`,
      `MISSING at currentZ=${result.missingAtCurrentZ}`)
    console.log('[catalog by zoom]', result.cachedByZ, 'total', result.cachedTotal)
    console.log('[backend state]',
      `loadingTiles=${result.loadingTiles}`,
      `abortControllers=${result.abortControllers}`,
      `pendingMvt=${result.pendingMvt}`,
      `prefetchKeys=${result.prefetchKeys}`,
      `evictShield=${result.evictShield}`)
    if (result.missingAtCurrentZ > 0) {
      console.log('[missing keys]', result.missingKeys.join(' '))
    }

    // After 10 s of idle, every visible tile at currentZ MUST be
    // cached. Anything missing means parent-walk fallback is
    // covering for an absent fetch — visual stripe of lower-detail
    // rendering across the canvas.
    expect(result.missingAtCurrentZ).toBe(0)
  })
})
