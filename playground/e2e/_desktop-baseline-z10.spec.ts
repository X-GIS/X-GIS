// User-reported baseline for desktop perf: zoom 10.25 over Seoul,
// 1500×907 viewport. Reports triangles + lines + GPU timing so we
// can tell whether the measurement is at industry baseline or
// still has headroom.

import { test, expect } from '@playwright/test'

interface VTRDiag {
  getDrawStats?: () => {
    tilesVisible: number
    drawCalls: number
    triangles?: number
    lines?: number
  }
  _frameDrawnByZoom?: Map<number, number>
  _hysteresisZ?: number
  _frameTileCache?: { tiles?: { z: number; x: number; y: number }[] }
}
interface XgisMap {
  vtSources?: Map<string, { renderer: VTRDiag }>
  camera?: { zoom: number; pitch?: number }
}
declare global {
  interface Window { __xgisMap?: XgisMap; __xgisReady?: boolean }
}

test.describe('Desktop baseline z=10 Seoul', () => {
  test.use({ viewport: { width: 1500, height: 907 } })

  test('zoom 10.25 / pitch 0 / 1500×907: triangles + visible distribution', async ({ page }) => {
    test.setTimeout(60_000)

    await page.goto(
      `/demo.html?id=pmtiles_layered#10.25/37.60144/126.93894/0/0`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(() => window.__xgisReady === true, null, { timeout: 30_000 })
    await page.waitForFunction(() => {
      const map = window.__xgisMap
      if (!map?.vtSources) return false
      let v = 0
      for (const { renderer } of map.vtSources.values()) {
        v += renderer.getDrawStats?.().tilesVisible ?? 0
      }
      return v > 0
    }, null, { timeout: 60_000 })
    await page.waitForTimeout(5000)

    const result = await page.evaluate(() => {
      const map = window.__xgisMap!
      const out = {
        cameraZoom: map.camera?.zoom ?? 0,
        currentZ: -1,
        peaks: { tilesVisible: 0, drawCalls: 0, triangles: 0, lines: 0 },
        drawnByZoom: {} as Record<number, number>,
        visibleByZoom: {} as Record<number, number>,
      }
      for (const { renderer } of map.vtSources!.values()) {
        const ds = renderer.getDrawStats?.()
        if (ds) {
          out.peaks.tilesVisible = Math.max(out.peaks.tilesVisible, ds.tilesVisible)
          out.peaks.drawCalls = Math.max(out.peaks.drawCalls, ds.drawCalls)
          out.peaks.triangles = Math.max(out.peaks.triangles, ds.triangles ?? 0)
          out.peaks.lines = Math.max(out.peaks.lines, ds.lines ?? 0)
        }
        const cz = renderer._hysteresisZ
        if (typeof cz === 'number') out.currentZ = cz
        const dz = renderer._frameDrawnByZoom
        if (dz) {
          for (const [z, n] of dz) {
            out.drawnByZoom[z] = (out.drawnByZoom[z] ?? 0) + n
          }
        }
        const visTiles = renderer._frameTileCache?.tiles
        if (visTiles) {
          for (const t of visTiles) {
            out.visibleByZoom[t.z] = (out.visibleByZoom[t.z] ?? 0) + 1
          }
        }
      }
      return out
    })

    console.log('[desktop-baseline]', result)
    // Sanity: at zoom 10 over Seoul on 1500×907, single-zoom Mapbox
    // selector should pick ~15-25 unique z=10 tiles. With ~4 layer
    // slices each, total tilesVisible ≈ 60-100. Anything else is a
    // regression.
    expect(result.peaks.tilesVisible).toBeLessThan(120)
  })
})
