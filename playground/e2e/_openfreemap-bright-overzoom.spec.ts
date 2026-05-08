// User's reported URL: zoom=18.5 (over-zoom past OpenFreeMap maxz=14)
// at pitch=67.5° over Sejong, Korea. Capture: how many unique .pbf
// tiles, what zoom levels are actually drawn, frame time at steady
// state, and pending-upload pressure.
//
// At over-zoom we should fall back to the source's max indexed zoom
// (14) and stay there — sub-tile generation creates child geometry
// from parent tiles in CPU. If something in the LOD path is asking
// for tiles above z=14 (or duplicating the same z=14 tile across
// many sub-cells) the count blows up exactly as the user describes.

import { test, expect } from '@playwright/test'

const URL_HASH = '#18.5/36.52627/127.02945/15.0/67.5'

test('user URL: z=18.5 pitch=67.5 over-zoom diagnostic', async ({ page }) => {
  test.setTimeout(60_000)

  const fetches: string[] = []
  page.on('response', resp => {
    const u = resp.url()
    if (/openfreemap\.org\/.*\.pbf/.test(u)) fetches.push(u)
  })
  const consoleLogs: string[] = []
  page.on('console', m => consoleLogs.push(`[${m.type()}] ${m.text()}`))

  await page.goto(`/demo.html?id=openfreemap_bright${URL_HASH}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(8_000)

  const result = await page.evaluate(async () => {
    return await new Promise<{
      frames: number[]
      pipeline: unknown
      byZoom: Record<number, number>
      cacheSize: number
      catalogStats: unknown
    }>((res) => {
      const frames: number[] = []
      let last = performance.now()
      const start = last
      const tick = () => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        if (now - start < 3000) requestAnimationFrame(tick)
        else {
          const map = (window as unknown as {
            __xgisMap?: {
              inspectPipeline?: () => unknown
              vtSources?: Map<string, {
                source?: {
                  _allTileData?: Map<unknown, unknown>
                  _loadingTiles?: Map<unknown, unknown>
                  hasTileData?: (k: number) => boolean
                  hasEntryInIndex?: (k: number) => boolean
                }
                renderer?: {
                  _frameDrawnByZoom?: Map<number, number>
                  _frameTileCache?: { tiles?: Array<{ z: number; x: number; y: number }> }
                  gpuCache?: { size?: number }
                  showCommands?: Array<{ targetName: string; sourceLayer?: string }>
                }
              }>
              showCommands?: Array<{ targetName: string; sourceLayer?: string; filterExpr?: { ast?: unknown } }>
            }
          }).__xgisMap
          const vt = map?.vtSources?.get?.('openmaptiles')
          const byZoomMap = vt?.renderer?._frameDrawnByZoom
          const byZoom: Record<number, number> = {}
          if (byZoomMap instanceof Map) {
            for (const [z, n] of byZoomMap) byZoom[z] = n
          }
          const pipeline = map?.inspectPipeline ? map.inspectPipeline() : null
          // Inspect the actual requested-tile set from the last selection.
          const tilesSeen: Record<number, number> = {}
          const cached = vt?.renderer?._frameTileCache
          if (cached?.tiles) {
            for (const t of cached.tiles) tilesSeen[t.z] = (tilesSeen[t.z] ?? 0) + 1
          }
          // How many shows do we have, how many distinct (sourceLayer + filter) slices?
          const shows = map?.showCommands ?? []
          const omShows = shows.filter(s => s.targetName === 'openmaptiles')
          const sliceKeys = new Set<string>()
          for (const s of omShows) {
            const filterStr = s.filterExpr ? JSON.stringify(s.filterExpr.ast) : ''
            sliceKeys.add(`${s.sourceLayer ?? ''}|${filterStr.slice(0, 40)}`)
          }
          const catalogStats = {
            visibleByZoom: tilesSeen,
            visibleTotal: cached?.tiles?.length ?? 0,
            allCachedTiles: vt?.source?._allTileData instanceof Map ? vt.source._allTileData.size : -1,
            loadingTiles: vt?.source?._loadingTiles instanceof Map ? vt.source._loadingTiles.size : -1,
            shows: omShows.length,
            distinctSlices: sliceKeys.size,
          }
          res({ frames, pipeline, byZoom, cacheSize: vt?.renderer?.gpuCache?.size ?? -1, catalogStats })
        }
      }
      requestAnimationFrame(tick)
    })
  })

  // Group fetches by zoom level so we see the over-zoom story.
  const byZoomFetched: Record<number, number> = {}
  const tileSet = new Set<string>()
  for (const u of fetches) {
    const m = u.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf/)
    if (!m) continue
    const z = parseInt(m[1])
    byZoomFetched[z] = (byZoomFetched[z] ?? 0) + 1
    tileSet.add(`${m[1]}/${m[2]}/${m[3]}`)
  }

  const sorted = [...result.frames].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const p95 = sorted[Math.floor(sorted.length * 0.95)]

  // eslint-disable-next-line no-console
  console.log('\n=== z=18.5 pitch=67.5 (Sejong, Korea) over-zoom diagnostic ===')
  // eslint-disable-next-line no-console
  console.log(`network unique .pbf tiles: ${tileSet.size}`)
  // eslint-disable-next-line no-console
  console.log(`fetches by source-zoom: ${JSON.stringify(byZoomFetched)}`)
  // eslint-disable-next-line no-console
  console.log(`drawnByZoom (per frame): ${JSON.stringify(result.byZoom)}`)
  const ip = result.pipeline as { sources?: Array<{ frame: { drawCalls: number; tilesVisible: number; missedTiles: number }; cache: { size: number; pendingUploads: number } }> } | null
  const src = ip?.sources?.[0]
  // eslint-disable-next-line no-console
  console.log(`drawCalls=${src?.frame.drawCalls} slicesDrawn=${src?.frame.tilesVisible} missed=${src?.frame.missedTiles}`)
  // eslint-disable-next-line no-console
  console.log(`cache.size=${src?.cache.size} pendingUploads=${src?.cache.pendingUploads}`)
  // eslint-disable-next-line no-console
  console.log(`frame: median=${median.toFixed(1)}ms (${(1000/median).toFixed(0)} fps) p95=${p95.toFixed(1)}ms over ${result.frames.length} samples`)
  // eslint-disable-next-line no-console
  console.log(`catalog: ${JSON.stringify(result.catalogStats)}`)
  // Surface any FLICKER / sub-tile / over-zoom log lines.
  const interesting = consoleLogs.filter(l => /FLICKER|sub-tile|overzoom|Sub-tile|gpuCache=|missedTiles/i.test(l))
  if (interesting.length > 0) {
    // eslint-disable-next-line no-console
    console.log('--- runtime log signals ---')
    // eslint-disable-next-line no-console
    console.log(interesting.slice(0, 10).join('\n  '))
  }

  await page.locator('#map').screenshot({ path: 'test-results/openfreemap-bright-overzoom.png' })

  expect(tileSet.size).toBeGreaterThan(0)
  // Pre-fix this URL was 235 ms / 4 fps because 81 shows × 150
  // visible tiles re-ran classifyTile() per (tile, slice) for every
  // show even though only 13 distinct slices existed. Frame-scoped
  // memoization brought it to ~50 ms / 20 fps. Lock in <100 ms so a
  // regression that re-introduces the 6× redundant work fails fast.
  expect(median, `over-zoom z=18.5 pitch=67.5 should stay under 100 ms median (was ${median.toFixed(0)} ms)`).toBeLessThan(100)
})
