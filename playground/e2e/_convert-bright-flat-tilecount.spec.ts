// Are we requesting "엄청나게 많은 타일" at low pitch?
//
// At flat pitch (pitch=0) we should only need a small grid of unique
// tiles at the camera's zoom — z=14 over Tokyo is roughly a 4×3
// viewport. The bright style stacks 81 shows on top, so EACH unique
// tile produces ~16 slice-draws — 12 unique tiles × ~81 shows = ~970
// drawCalls. That's the number perf overlays show, but it's not the
// network or GPU-upload count.
//
// This spec separates: (a) unique .pbf tile fetches, (b) GPU-cached
// tile-slice count, (c) drawCalls. So we can answer the user's
// question with hard numbers rather than guessing.

import { test, expect } from '@playwright/test'
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(__dirname, '__convert-fixtures/bright.json'), 'utf8')

test('flat pitch at Tokyo z=14: unique fetches vs draw calls', async ({ page }) => {
  test.setTimeout(60_000)
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript((src: string) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'Bright')
  }, xgis)

  const fetches = new Set<string>()
  page.on('response', resp => {
    const u = resp.url()
    if (/openfreemap\.org\/.*\.pbf/.test(u)) fetches.add(u)
  })

  await page.goto('/demo.html?id=__import#14/35.68/139.76/0/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(8_000) // settle

  const stats = await page.evaluate(() => {
    const map = (window as unknown as {
      __xgisMap?: {
        inspectPipeline?: () => unknown
        vtSources?: Map<string, { source?: { _allTileData?: Map<unknown, unknown> }; renderer?: { _frameDrawnByZoom?: Map<number, number> } }>
      }
    }).__xgisMap
    const ip = map?.inspectPipeline?.() as { sources?: Array<{ frame: { drawCalls: number; tilesVisible: number; missedTiles: number } }> } | null
    const vt = map?.vtSources?.get?.('openmaptiles')
    const allTiles = vt?.source?._allTileData
    const byZoom: Record<number, number> = {}
    if (vt?.renderer?._frameDrawnByZoom instanceof Map) {
      for (const [z, n] of vt.renderer._frameDrawnByZoom) byZoom[z] = n
    }
    return {
      drawCalls: ip?.sources?.[0]?.frame.drawCalls,
      slicesDrawn: ip?.sources?.[0]?.frame.tilesVisible,
      missed: ip?.sources?.[0]?.frame.missedTiles,
      cachedSlices: allTiles instanceof Map ? allTiles.size : -1,
      byZoom,
    }
  })

  // Each unique .pbf tile decoded by mvt-worker becomes N source-layer
  // slices (one per OpenMapTiles source-layer the bright style touches).
  // Compute the inferred unique-tile count from the network fetches.
  const uniqueTilesFromNetwork = fetches.size

  // eslint-disable-next-line no-console
  console.log('\n=== flat-pitch tile-count audit (Tokyo z=14, pitch=0) ===')
  // eslint-disable-next-line no-console
  console.log(`network unique .pbf tiles fetched: ${uniqueTilesFromNetwork}`)
  // eslint-disable-next-line no-console
  console.log(`GPU-cached slices (tile × source-layer): ${stats.cachedSlices}`)
  // eslint-disable-next-line no-console
  console.log(`per-frame drawCalls: ${stats.drawCalls}  slicesDrawn: ${stats.slicesDrawn}  missed: ${stats.missed}`)
  // eslint-disable-next-line no-console
  console.log(`drawnByZoom: ${JSON.stringify(stats.byZoom)}`)
  // eslint-disable-next-line no-console
  console.log(`inferred slices per unique tile: ~${stats.cachedSlices && uniqueTilesFromNetwork ? Math.round((stats.cachedSlices) / uniqueTilesFromNetwork) : '?'}`)

  // At pitch=0 over Tokyo z=14 with our test viewport (~860×720), a
  // 4×3 tile grid covers the visible area. Allow some slack for the
  // 1-tile margin used by the frustum sampler.
  expect(uniqueTilesFromNetwork, 'flat pitch over Tokyo z=14 should request a small unique-tile set').toBeLessThan(40)
})
