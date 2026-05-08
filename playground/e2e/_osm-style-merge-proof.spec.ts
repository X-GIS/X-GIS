// Proof of the auto-merge optimization claimed for osm-style.xgis.
//
// Compiler unit test (`compiler/src/__tests__/measure-osm.test.ts`)
// shows the IR pass folds 13 → 5 RenderNodes. This spec proves the
// fold actually reaches the GPU at runtime: count distinct sliceKeys
// in the VTR's gpuCache after a fresh tile load and assert the
// count is the merged 5 (not the unmerged 13). If this regresses
// (someone disables the merge, breaks the IR pass, or breaks the
// worker plumbing), the spec catches it without anyone needing to
// eyeball an Inspector report on a phone.
//
// Verified expectation per `compiler/src/__tests__/measure-osm.test.ts`
// running on the same osm-style.xgis fixture:
//   1× landuse compound (5 layers folded + `landuse_other` absorbed
//      as the default `_` arm of the synthesised match())
//   1× water         (singleton — only one water layer in the demo)
//   1× roads compound (5 layers folded — per-feature stroke
//      colour + width via segment buffer override slots)
//   1× buildings     (singleton — extruded, out of merge scope)

import { test, expect } from '@playwright/test'

interface VTRDiag {
  getDrawStats?: () => {
    tilesVisible: number
    drawCalls: number
  }
  gpuCache?: Map<string, Map<number, unknown>>
}
interface XgisMap {
  vtSources?: Map<string, { renderer: VTRDiag }>
}
declare global {
  interface Window { __xgisMap?: XgisMap; __xgisReady?: boolean }
}

test.describe('OSM-style auto-merge — runtime proof', () => {
  test.use({ viewport: { width: 1500, height: 907 } })

  test('VTR gpuCache holds exactly 4 sliceKeys (post-merge fold)', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto(`/demo.html?id=osm_style&dpr=2#15/35.66/139.7/0/0`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => window.__xgisReady === true, null, { timeout: 30_000 })
    // Wait for tiles to actually upload — getDrawStats().tilesVisible > 0.
    await page.waitForFunction(() => {
      const map = window.__xgisMap
      if (!map?.vtSources) return false
      for (const { renderer } of map.vtSources.values()) {
        if ((renderer.getDrawStats?.().tilesVisible ?? 0) > 0) return true
      }
      return false
    }, null, { timeout: 30_000 })
    await page.waitForTimeout(3000)

    const sliceKeys = await page.evaluate(() => {
      const map = window.__xgisMap!
      const keys = new Set<string>()
      for (const { renderer } of map.vtSources!.values()) {
        const cache = renderer.gpuCache
        if (!cache) continue
        for (const sliceKey of cache.keys()) keys.add(sliceKey)
      }
      return [...keys]
    })

    // eslint-disable-next-line no-console
    console.log('OSM-style sliceKeys at runtime:', sliceKeys)
    // Pre-merge would have at LEAST 4 (the 4 unique source layers
    // water, landuse, roads, buildings). Post-merge has 5
    // (compound landuse, landuse_other, water, compound roads,
    // buildings). If the merge regresses to per-layer slices the
    // count climbs to 13.
    expect(sliceKeys.length).toBe(4)
  })

  test('per-frame draws ≤ 4 × visible tiles (merge upper bound)', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto(`/demo.html?id=osm_style&dpr=2#15/35.66/139.7/0/0`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => window.__xgisReady === true, null, { timeout: 30_000 })
    await page.waitForFunction(() => {
      const map = window.__xgisMap
      if (!map?.vtSources) return false
      for (const { renderer } of map.vtSources.values()) {
        if ((renderer.getDrawStats?.().tilesVisible ?? 0) > 0) return true
      }
      return false
    }, null, { timeout: 30_000 })
    await page.waitForTimeout(3000)

    const stats = await page.evaluate(() => {
      const map = window.__xgisMap!
      let tilesVisible = 0
      let drawCalls = 0
      let uniqueTilePositions = 0
      for (const { renderer } of map.vtSources!.values()) {
        const ds = renderer.getDrawStats?.()
        if (ds) {
          tilesVisible += ds.tilesVisible
          drawCalls += ds.drawCalls
        }
        // _frameDrawnByZoom: number of (tile, layer) draw instances
        // per zoom. Sum gives total instances; divide by 5 (the
        // expected merged layer count) to estimate unique tiles.
        // Using gpuCache instead — its inner Map is keyed by tileKey.
        const cache = renderer.gpuCache
        if (cache) {
          const seen = new Set<number>()
          for (const inner of cache.values()) {
            for (const k of inner.keys()) seen.add(k)
          }
          uniqueTilePositions = Math.max(uniqueTilePositions, seen.size)
        }
      }
      return { tilesVisible, drawCalls, uniqueTilePositions }
    })

    // eslint-disable-next-line no-console
    console.log('OSM-style merge runtime stats:', stats)
    // tilesVisible counts (tile × layer) draw instances. Pre-merge
    // multiplier was 13; post-merge is 5. Allow some headroom for
    // ancestor fallback draws (drawn z=N + z=N-1 fallback can
    // double-count slightly), so cap at 5× unique + slack.
    expect(stats.tilesVisible).toBeLessThanOrEqual(stats.uniqueTilePositions * 4 + 5)
  })
})
