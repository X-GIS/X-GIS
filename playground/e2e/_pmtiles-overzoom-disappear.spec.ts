// Reproduction for "tiles gradually disappear at z=15.5+ over-zoom"
// (pmtiles_layered demo, PMTiles maxZoom=15).
//
// Hypothesis classes:
//   A. CACHE DEGRADATION — gpuCache or dataCache loses entries over
//      time (eviction, race, leak)
//   B. UPLOAD STALL — pending uploads stop draining; visible coverage
//      never converges
//   C. RENDER REGRESSION — tile draws stop emitting even with cache
//      populated
//   D. PIXEL FALSIFICATION — caches are stable but actual rendered
//      pixels lose content (depth/stencil race, overdraw clobber)
//
// Test plan:
//   1. Navigate to z=15.5 over Seoul, wait for ready.
//   2. Take T0 snapshot of cache/pending/missed + center-region pixel
//      density (count of non-background pixels).
//   3. Hold camera static for 8 s with no input.
//   4. Take T8 snapshot. Compare against T0:
//        - cacheSize must NOT decrease
//        - tilesVisible must NOT decrease (per source)
//        - Pixel density must NOT drop > 10%

import { test, expect, type Page } from '@playwright/test'

const READY_TIMEOUT_MS = 30_000
const HOLD_DURATION_MS = 8_000
const SOAK_INTERVAL_MS = 1_000

interface SourceSnapshot {
  name: string
  cacheSize: number
  pendingLoads: number
  pendingUploads: number
  missedTiles: number
  tilesVisible: number
}

async function waitForXgisReady(page: Page): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < READY_TIMEOUT_MS) {
    const ready = await page.evaluate(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    )
    if (ready) return
    await page.waitForTimeout(100)
  }
  throw new Error(`__xgisReady did not become true within ${READY_TIMEOUT_MS} ms`)
}

async function snapshotSources(page: Page): Promise<SourceSnapshot[]> {
  return await page.evaluate(() => {
    const map = (window as unknown as { __xgisMap?: { inspectPipeline(): unknown } }).__xgisMap
    if (!map) return []
    const pipe = map.inspectPipeline() as {
      sources: Array<{
        name: string
        cache: { size: number; pendingLoads: number; pendingUploads: number }
        frame: { missedTiles: number; tilesVisible: number }
      }>
    }
    return pipe.sources.map(s => ({
      name: s.name,
      cacheSize: s.cache.size,
      pendingLoads: s.cache.pendingLoads,
      pendingUploads: s.cache.pendingUploads,
      missedTiles: s.frame.missedTiles,
      tilesVisible: s.frame.tilesVisible,
    }))
  })
}

/** Count pixels in a center region that are NOT pure white (the
 *  background fill in the latest pmtiles_layered demo). Returns
 *  the proportion of "drawn" pixels — drops near zero would
 *  indicate tiles disappeared visually. */
async function pixelDensity(page: Page): Promise<number> {
  const shot = await page.locator('canvas#map').screenshot({ type: 'png' })
  return await page.evaluate(async ({ pngBytes }) => {
    const blob = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('img load'))
      img.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    // Sample a center region (avoid editor / status bar edges).
    const x0 = Math.floor(img.width * 0.1)
    const y0 = Math.floor(img.height * 0.1)
    const w = Math.floor(img.width * 0.8)
    const h = Math.floor(img.height * 0.8)
    const data = ctx.getImageData(x0, y0, w, h).data
    let drawn = 0, total = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2]
      // background = stone-100 ≈ rgb(245, 245, 244). Count anything
      // distinct from that as "drawn".
      const isBg = r > 240 && g > 240 && b > 240
      if (!isBg) drawn++
      total++
    }
    URL.revokeObjectURL(url)
    return drawn / total
  }, { pngBytes: Array.from(shot) })
}

function formatSnapshot(snapshots: SourceSnapshot[]): string {
  return snapshots.map(s =>
    `  ${s.name.padEnd(12)} cache=${String(s.cacheSize).padStart(4)} ` +
    `pend(load/up)=${s.pendingLoads}/${s.pendingUploads} ` +
    `missed=${String(s.missedTiles).padStart(3)} vis=${s.tilesVisible}`,
  ).join('\n')
}

test.describe('PMTiles over-zoom: gradual disappearance repro', () => {
  // Parameterised across zoom × pitch combinations to cover the
  // user-reported scenarios. z=15.5 is the first over-zoom step.
  // z=17 is 2 levels of sub-tile chain. Pitch values match the
  // user's earlier screenshots (pitch=45.6, pitch=58.5).
  const SCENARIOS = [
    { zoom: 15.5, pitch: 0,    name: 'z=15.5 flat' },
    { zoom: 16.15, pitch: 0,   name: 'z=16.15 flat (user-reported broken)' },
    { zoom: 16.5, pitch: 0,    name: 'z=16.5 flat (2-level chain)' },
    { zoom: 17.0, pitch: 0,    name: 'z=17 flat' },
    { zoom: 15.5, pitch: 45.6, name: 'z=15.5 pitch=45.6' },
    { zoom: 17.0, pitch: 45.6, name: 'z=17 pitch=45.6' },
  ] as const

  for (const sc of SCENARIOS) {
    test(`${sc.name}: static camera holds visible tiles for 8s`, async ({ page }) => {
      test.setTimeout(READY_TIMEOUT_MS + HOLD_DURATION_MS + 30_000)
      await page.setViewportSize({ width: 1280, height: 720 })

      const flickerLogs: string[] = []
      page.on('console', m => {
        const t = m.text()
        if (t.includes('[FLICKER]')) flickerLogs.push(t)
      })

      const hash = `#${sc.zoom}/37.5/127.0/0.0/${sc.pitch}`
      await page.goto(`/demo.html?id=pmtiles_layered&proj=mercator${hash}`, {
        waitUntil: 'domcontentloaded',
      })
      await waitForXgisReady(page)
      await page.waitForTimeout(4000)

      const t0 = await snapshotSources(page)
      const px0 = await pixelDensity(page)
      console.log(`\n=== ${sc.name} ===`)
      console.log('[T=4s post-init]')
      console.log(formatSnapshot(t0))
      console.log(`  pixel density: ${(px0 * 100).toFixed(1)}%`)

      const timeline: Array<{ t: number; sources: SourceSnapshot[]; px: number }> = []
      const start = Date.now()
      while (Date.now() - start < HOLD_DURATION_MS) {
        await page.waitForTimeout(SOAK_INTERVAL_MS)
        const t = Math.round((Date.now() - start) / 1000)
        const sources = await snapshotSources(page)
        const px = await pixelDensity(page)
        timeline.push({ t, sources, px })
        console.log(`[T=${t}s] pixel=${(px * 100).toFixed(1)}%`)
        console.log(formatSnapshot(sources))
      }

      const tEnd = timeline[timeline.length - 1]
      console.log(`[FLICKER messages]: ${flickerLogs.length}`)
      // Save screenshot for visual diagnosis.
      const safeName = sc.name.replace(/[^a-z0-9]+/gi, '_')
      await page.locator('canvas#map').screenshot({
        path: `test-results/overzoom-${safeName}.png`,
      })

      // Dump sub-tile internals — count cached entries per slice
      // and probe a sample z=16 sub-tile's vertex/index validity.
      const subTileDiag = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const map = (window as any).__xgisMap
        if (!map?.vtSources) return null
        // Decode z from the packed tileKey (compiler/tile-format).
        // tileKey packs z, x, y so the high bits give z. The exact
        // bit layout is internal but `tileKeyUnpack` is exposed.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const unpack = (window as any).__xgisInternals?.tileKeyUnpack
        const out: Record<string, unknown> = {}
        for (const [name, entry] of map.vtSources.entries()) {
          const src = entry.source
          const dataCache = src.dataCache as Map<number, Map<string, unknown>>
          const summary: Record<string, { byZoom: Record<number, number>; total: number }> = {}
          if (dataCache) {
            for (const [tk, slot] of dataCache.entries()) {
              const z = unpack ? unpack(tk)[0] : -1
              for (const layerName of slot.keys()) {
                const k = layerName as string
                if (!summary[k]) summary[k] = { byZoom: {}, total: 0 }
                summary[k].byZoom[z] = (summary[k].byZoom[z] ?? 0) + 1
                summary[k].total++
              }
            }
          }
          out[name as string] = {
            sourceMaxLevel: src.maxLevel,
            cacheSize: src.getCacheSize(),
            slices: summary,
          }
        }
        return out
      })
      console.log('[sub-tile-diag]', JSON.stringify(subTileDiag, null, 2))

      for (const src of t0) {
        const endSrc = tEnd.sources.find(s => s.name === src.name)
        expect(endSrc, `${src.name} disappeared from sources list`).toBeDefined()
        expect(
          endSrc!.cacheSize,
          `${src.name}: cacheSize dropped (${src.cacheSize} → ${endSrc!.cacheSize})`,
        ).toBeGreaterThanOrEqual(src.cacheSize - 2)
      }
      for (const s of tEnd.sources) {
        expect(s.tilesVisible, `${s.name}: stopped drawing`).toBeGreaterThan(0)
      }
      expect(
        tEnd.px,
        `pixel density collapsed: ${(px0 * 100).toFixed(1)}% → ${(tEnd.px * 100).toFixed(1)}%`,
      ).toBeGreaterThanOrEqual(px0 * 0.9)
      // City-scale views over Seoul MUST have substantive content
      // — buildings + roads dense at z=15+. Less than 5% non-bg
      // pixels means tiles aren't actually putting geometry on the
      // viewport regardless of stat counters. This catches the
      // user-reported "tiles invisible" condition that the cache
      // / tilesVisible accumulators alone wouldn't surface.
      const SEOUL_LAT = 37.5
      if (Math.abs(SEOUL_LAT - 37.5) < 1) {
        expect(
          tEnd.px,
          `pixel density too low (${(tEnd.px * 100).toFixed(1)}%) — Seoul at ${sc.name} should render visible features`,
        ).toBeGreaterThan(0.05)
      }
    })
  }

  // ORIGINAL z=15.5 flat-camera test removed — covered by SCENARIOS[0].
  test.skip('at z=15.5 Seoul, static camera holds visible tiles for 8s', async ({ page }) => {
    test.setTimeout(READY_TIMEOUT_MS + HOLD_DURATION_MS + 30_000)
    await page.setViewportSize({ width: 1280, height: 720 })

    // Capture FLICKER warnings for diagnostic — they shouldn't fire
    // continuously after settle (grace period 240 frames).
    const flickerLogs: string[] = []
    page.on('console', m => {
      const t = m.text()
      if (t.includes('[FLICKER]')) flickerLogs.push(t)
    })

    // z=15.5 is the first integer-rounded zoom that requires
    // sub-tile generation past PMTiles maxZoom=15.
    await page.goto(`/demo.html?id=pmtiles_layered&proj=mercator#15.5/37.5/127.0`, {
      waitUntil: 'domcontentloaded',
    })
    await waitForXgisReady(page)

    // Initial settle — 4 s for first PMTiles fetches + sub-tile
    // generation for the 4 layers.
    await page.waitForTimeout(4000)

    const t0 = await snapshotSources(page)
    const px0 = await pixelDensity(page)
    console.log('[T=4s post-init]')
    console.log(formatSnapshot(t0))
    console.log(`  pixel density: ${(px0 * 100).toFixed(1)}%`)

    // Soak — sample every second for 8 s with no input.
    const timeline: Array<{ t: number; sources: SourceSnapshot[]; px: number }> = []
    const start = Date.now()
    while (Date.now() - start < HOLD_DURATION_MS) {
      await page.waitForTimeout(SOAK_INTERVAL_MS)
      const t = Math.round((Date.now() - start) / 1000)
      const sources = await snapshotSources(page)
      const px = await pixelDensity(page)
      timeline.push({ t, sources, px })
      console.log(`[T=${t}s] pixel=${(px * 100).toFixed(1)}%`)
      console.log(formatSnapshot(sources))
    }

    const tEnd = timeline[timeline.length - 1]
    console.log(`\n[FLICKER messages observed]: ${flickerLogs.length}`)
    if (flickerLogs.length > 0) {
      console.log('  first:', flickerLogs[0])
      console.log('  last:', flickerLogs[flickerLogs.length - 1])
    }

    // === ORACLES ===
    // 1. CacheSize must not decrease over the soak.
    for (const src of t0) {
      const endSrc = tEnd.sources.find(s => s.name === src.name)
      expect(endSrc, `${src.name} disappeared from sources list`).toBeDefined()
      expect(
        endSrc!.cacheSize,
        `${src.name}: cacheSize dropped (${src.cacheSize} → ${endSrc!.cacheSize})`,
      ).toBeGreaterThanOrEqual(src.cacheSize - 2)
    }

    // 2. tilesVisible must not collapse to zero.
    for (const s of tEnd.sources) {
      expect(s.tilesVisible, `${s.name}: stopped drawing`).toBeGreaterThan(0)
    }

    // 3. Pixel density must not drop > 10%. Allow small fluctuations
    //    from prefetch upload slowly increasing detail, but a
    //    sustained drop signals real disappearance.
    expect(
      tEnd.px,
      `pixel density collapsed: ${(px0 * 100).toFixed(1)}% → ${(tEnd.px * 100).toFixed(1)}%`,
    ).toBeGreaterThanOrEqual(px0 * 0.9)
  })
})
