// Continuous wheel-zoom stress: simulates a real user spinning the
// scroll wheel for several seconds. Unlike the instant-jump specs
// (camera.zoom = 16 in one tick), this exercises the per-frame
// gate / prefetch / pool paths with the cadence the runtime
// actually sees in production:
//
//   * Each rAF tick gets a small zoom delta (~0.05-0.1)
//   * cameraIdle stays FALSE the entire gesture (200 ms grace
//     not satisfied while wheel events keep arriving)
//   * Bulk-jump bypass NEVER fires (delta-per-frame << 4)
//   * Buffer pool / gate / prefetch all see hot churn
//
// Two-phase: 5 s zoom-in (12 → 17), 5 s zoom-out (17 → 12).
// Sample backend collections + heap mid-gesture so any unbounded
// growth or stuck-state surfaces.

import { test, expect } from '@playwright/test'

interface XgisMap {
  vtSources: Map<string, { renderer: { source: unknown; getDrawStats?: () => { tilesVisible: number; drawCalls: number } } }>
  camera: { zoom: number; centerX: number; centerY: number }
}
declare global {
  interface Window { __xgisMap?: XgisMap; __xgisReady?: boolean }
}

interface Sample {
  zoom: number
  tilesVisible: number
  drawCalls: number
  loadingTiles: number
  abortControllers: number
  heapMB: number | null
}

test.describe('Continuous wheel-zoom: bounded backend state under sustained gesture', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('5 s in + 5 s out: tilesVisible + heap stay bounded mid-gesture', async ({ page }) => {
    test.setTimeout(120_000)

    await page.addInitScript(() => {
      ;(window as unknown as { __cacheStats: () => unknown, __installCacheTelemetry: () => void }).__installCacheTelemetry = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const map = (window as any).__xgisMap
        if (!map?.vtSources) return
        const stats = {
          bufferPoolHits: 0,
          bufferPoolMisses: 0,
          gpuCacheHits: 0,
          gpuCacheMisses: 0,
          hasTileDataHits: 0,
          hasTileDataMisses: 0,
        }
        for (const { renderer } of map.vtSources.values()) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = renderer as any
          if (r.__telemetryInstalled) continue
          r.__telemetryInstalled = true
          const origAcquire = r.acquireBuffer.bind(r)
          r.acquireBuffer = (size: number, usage: number, label: string) => {
            let bucket = 2048
            while (bucket < size) bucket *= 2
            const key = `${bucket}:${usage}`
            const pool = r._bufferPool?.get?.(key)
            if (pool && pool.length > 0) stats.bufferPoolHits++
            else stats.bufferPoolMisses++
            return origAcquire(size, usage, label)
          }
          const origDoUpload = r.doUploadTile.bind(r)
          r.doUploadTile = (key: number, data: unknown, sourceLayer = '') => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const inner = r.gpuCache?.get?.(sourceLayer) as Map<number, unknown> | undefined
            if (inner?.has?.(key)) stats.gpuCacheHits++
            else stats.gpuCacheMisses++
            return origDoUpload(key, data, sourceLayer)
          }
          const catalog = r.source as { hasTileData?: (k: number, l?: string) => boolean }
          if (catalog?.hasTileData) {
            const orig = catalog.hasTileData.bind(catalog)
            catalog.hasTileData = (k: number, l?: string): boolean => {
              const v = orig(k, l)
              if (v) stats.hasTileDataHits++; else stats.hasTileDataMisses++
              return v
            }
          }
        }
        ;(window as unknown as { __cacheStats: () => unknown }).__cacheStats = () => stats
      }
    })

    await page.goto(
      `/demo.html?id=pmtiles_layered#13/35.68/139.76`,
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
        v += renderer.getDrawStats?.().tilesVisible ?? 0
      }
      return v > 0
    }, null, { timeout: 60_000 })
    await page.waitForTimeout(3000)

    // Drive the zoom inside page.evaluate so the per-frame deltas
    // happen on the renderer's rAF cadence — same as a real wheel
    // gesture. Capture a sample every ~5 frames so the trace
    // stays manageable.
    const result = await page.evaluate(async ({ startZoom, endZoom, durationMs, sampleEveryFrames }) => {
      const map = window.__xgisMap!
      const samples: Sample[] = []
      const t0 = performance.now()
      const targetEnd = t0 + durationMs
      let frame = 0
      while (performance.now() < targetEnd) {
        await new Promise<void>(r => requestAnimationFrame(() => r()))
        const elapsed = performance.now() - t0
        const t = Math.min(1, elapsed / durationMs)
        // Linear ramp; 60 fps × 5 s = 300 frames. delta per frame ≈
        // (endZoom - startZoom) / 300 — well below the bulk-jump
        // bypass threshold (>4 LODs in one tick).
        map.camera.zoom = startZoom + (endZoom - startZoom) * t
        frame++
        if (frame % sampleEveryFrames === 0) {
          let tilesVisible = 0, drawCalls = 0
          for (const { renderer } of map.vtSources.values()) {
            const ds = renderer.getDrawStats?.() ?? { tilesVisible: 0, drawCalls: 0 }
            tilesVisible = Math.max(tilesVisible, ds.tilesVisible)
            drawCalls = Math.max(drawCalls, ds.drawCalls)
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const renderer = [...map.vtSources.values()][0]?.renderer as any
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const catalog = renderer?.source as any
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const backend = catalog?.backends?.[0] as any
          const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          samples.push({
            zoom: map.camera.zoom,
            tilesVisible,
            drawCalls,
            loadingTiles: catalog?.loadingTiles?.size ?? -1,
            abortControllers: backend?.abortControllers?.size ?? -1,
            heapMB: heap ? Math.round(heap.usedJSHeapSize / 1048576) : null,
          })
        }
      }
      return samples
    }, { startZoom: 12, endZoom: 17, durationMs: 5000, sampleEveryFrames: 5 })

    // Reverse direction.
    const result2 = await page.evaluate(async ({ startZoom, endZoom, durationMs, sampleEveryFrames }) => {
      const map = window.__xgisMap!
      const samples: Sample[] = []
      const t0 = performance.now()
      const targetEnd = t0 + durationMs
      let frame = 0
      while (performance.now() < targetEnd) {
        await new Promise<void>(r => requestAnimationFrame(() => r()))
        const elapsed = performance.now() - t0
        const t = Math.min(1, elapsed / durationMs)
        map.camera.zoom = startZoom + (endZoom - startZoom) * t
        frame++
        if (frame % sampleEveryFrames === 0) {
          let tilesVisible = 0, drawCalls = 0
          for (const { renderer } of map.vtSources.values()) {
            const ds = renderer.getDrawStats?.() ?? { tilesVisible: 0, drawCalls: 0 }
            tilesVisible = Math.max(tilesVisible, ds.tilesVisible)
            drawCalls = Math.max(drawCalls, ds.drawCalls)
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const renderer = [...map.vtSources.values()][0]?.renderer as any
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const catalog = renderer?.source as any
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const backend = catalog?.backends?.[0] as any
          const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          samples.push({
            zoom: map.camera.zoom,
            tilesVisible,
            drawCalls,
            loadingTiles: catalog?.loadingTiles?.size ?? -1,
            abortControllers: backend?.abortControllers?.size ?? -1,
            heapMB: heap ? Math.round(heap.usedJSHeapSize / 1048576) : null,
          })
        }
      }
      return samples
    }, { startZoom: 17, endZoom: 12, durationMs: 5000, sampleEveryFrames: 5 })

    const all = [...result, ...result2]

    const peakTV = Math.max(...all.map(s => s.tilesVisible))
    const peakDC = Math.max(...all.map(s => s.drawCalls))
    const peakLoading = Math.max(...all.map(s => s.loadingTiles))
    const peakAbort = Math.max(...all.map(s => s.abortControllers))
    const heaps = all.map(s => s.heapMB).filter((x): x is number => x !== null)
    const peakHeap = heaps.length ? Math.max(...heaps) : null

    console.log(`[continuous wheel] frames sampled: ${all.length}`)
    console.log(`  peak tilesVisible:    ${peakTV}`)
    console.log(`  peak drawCalls:       ${peakDC}`)
    console.log(`  peak loadingTiles:    ${peakLoading}`)
    console.log(`  peak abortControllers:${peakAbort}`)
    if (peakHeap !== null) console.log(`  peak heap:            ${peakHeap} MB`)

    // Install telemetry post-settle so cold-start fetches don't
    // pollute the gesture-only hit-rate measurement.
    await page.evaluate(() => {
      ;(window as unknown as { __installCacheTelemetry: () => void }).__installCacheTelemetry()
    })
    // Re-run a shorter gesture for telemetry
    const drive = async (startZoom: number, endZoom: number, durationMs: number) =>
      page.evaluate(async ({ startZoom, endZoom, durationMs }) => {
        const map = window.__xgisMap!
        const t0 = performance.now()
        while (performance.now() - t0 < durationMs) {
          await new Promise<void>(r => requestAnimationFrame(() => r()))
          const t = Math.min(1, (performance.now() - t0) / durationMs)
          map.camera.zoom = startZoom + (endZoom - startZoom) * t
        }
      }, { startZoom, endZoom, durationMs })
    await drive(13, 16, 3000)
    await drive(16, 13, 3000)
    const cacheStats = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__cacheStats?.() ?? null
    }) as null | {
      bufferPoolHits: number; bufferPoolMisses: number
      gpuCacheHits: number; gpuCacheMisses: number
      hasTileDataHits: number; hasTileDataMisses: number
    }
    if (cacheStats) {
      const ratio = (h: number, m: number) =>
        h + m === 0 ? 'n/a' : `${(100 * h / (h + m)).toFixed(1)}%`
      console.log('[cache hit rates during continuous gesture]')
      console.log(`  bufferPool:  ${cacheStats.bufferPoolHits}h / ${cacheStats.bufferPoolMisses}m = ${ratio(cacheStats.bufferPoolHits, cacheStats.bufferPoolMisses)}`)
      console.log(`  gpuCache:    ${cacheStats.gpuCacheHits}h / ${cacheStats.gpuCacheMisses}m = ${ratio(cacheStats.gpuCacheHits, cacheStats.gpuCacheMisses)}`)
      console.log(`  hasTileData: ${cacheStats.hasTileDataHits}h / ${cacheStats.hasTileDataMisses}m = ${ratio(cacheStats.hasTileDataHits, cacheStats.hasTileDataMisses)}`)
    }

    // Settled-state ceilings — anything past these on a 1280×720
    // viewport during continuous zoom signals an unbounded path.
    expect(peakTV).toBeLessThan(200)
    expect(peakDC).toBeLessThan(2000)
    expect(peakLoading).toBeLessThan(60)
    expect(peakAbort).toBeLessThan(60)
    if (peakHeap !== null) expect(peakHeap).toBeLessThan(1500)
  })
})
