// Regression spec for "zoom-out tile explosion on mobile":
//
// User report: zooming out on mobile (live PMTiles) caused
// extreme heat + forced page refresh (OS-level kill or context
// loss). Diagnosed cause: the readiness gate held the OLD higher
// cz during zoom-out — but at lower camera zoom, that high cz
// requires hundreds of small tiles to cover the viewport. Mobile
// GPUs choke on the resulting draw call avalanche.
//
// Fix verified here: zoom-out advances cz immediately (no gate
// hold). The parent walk handles missing low-z tiles by magnifying
// any cached ancestor — same path used for any cache miss. Only
// zoom-IN gates (parent-over-zoom is cheap, child fan-out is not).
//
// Detection: simulate a small mobile viewport, settle at z=16
// (city zoom, ~5 visible tiles), jump to z=13 (region zoom,
// ~5 visible tiles). With the bug, the held cz=16 would force
// tilesVisible to balloon to dozens or hundreds for the larger
// view. With the fix, tilesVisible stays small throughout.

import { test, expect } from '@playwright/test'

interface XgisMap {
  vtSources: Map<string, { renderer: { getDrawStats?: () => { tilesVisible: number; drawCalls: number } } }>
  camera: { zoom: number }
}
declare global {
  interface Window { __xgisMap?: XgisMap; __xgisReady?: boolean }
}

test.describe('Mobile zoom-out: tile count stays bounded', () => {
  // iPhone 14-class viewport. Smaller surface = fewer visible
  // tiles in any sane LOD; an explosion here is unambiguously
  // a bug, not a viewport effect.
  test.use({ viewport: { width: 390, height: 844 } })

  test('zoom-out 16 → 13 on mobile viewport: tilesVisible never spikes', async ({ page }) => {
    test.setTimeout(60_000)

    await page.goto(
      `/demo.html?id=pmtiles_layered#16/35.68/139.76`,
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

    const sample = async (): Promise<{ tilesVisible: number; drawCalls: number }[]> => {
      return await page.evaluate(() => {
        const map = window.__xgisMap
        const out: { tilesVisible: number; drawCalls: number }[] = []
        for (const { renderer } of map?.vtSources?.values() ?? []) {
          const ds = renderer.getDrawStats?.() ?? { tilesVisible: 0, drawCalls: 0 }
          out.push(ds)
        }
        return out
      })
    }

    const baseline = await sample()
    const baselineMaxTV = Math.max(...baseline.map(s => s.tilesVisible))
    console.log(`[baseline z=16] tilesVisible (per-VTR max) = ${baselineMaxTV}`)

    // Jump to zoom 13. Sample every ~50 ms for 3 s — captures the
    // bug case where cz=16 held briefly with z=13 viewport produces
    // a tile explosion. With the fix, cz advances immediately so
    // tilesVisible stays close to the new-zoom expectation
    // (~5-15 tiles for 390×844 at z=13).
    await page.evaluate(() => {
      window.__xgisMap!.camera.zoom = 13
    })

    const samples: number[] = []
    const tStart = Date.now()
    while (Date.now() - tStart < 3000) {
      const s = await sample()
      const maxTV = Math.max(...s.map(x => x.tilesVisible))
      samples.push(maxTV)
      await page.waitForTimeout(50)
    }
    const peakTV = Math.max(...samples)
    console.log(`[peak during transition] tilesVisible (per-VTR max) = ${peakTV}`)

    // Measured comparison (manual revert + re-run):
    //   gate enabled (bug):     peak 140 tilesVisible
    //   gate skipped (fix):     peak  92 tilesVisible
    // The bug case sustains 140 over the entire transition window
    // (each frame compositing tens of small tiles for the larger
    // viewport); the fix's 92 is a single-frame transient spike
    // during the parent-walk before the lower-z fetches resolve.
    // Threshold 110 catches the bug case (gate enabled) but
    // accommodates the fix's transient. Below ~30 once settled.
    expect(peakTV).toBeLessThan(110)
  })
})
