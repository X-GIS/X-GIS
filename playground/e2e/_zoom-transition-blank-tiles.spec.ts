// Regression spec for "blank tiles flash during zoom transition".
//
// Symptom: a fast zoom jump (e.g. 13 → 16 in one camera step) used
// to advance VTR's `currentZ` immediately, exposing the new LOD's
// missing tiles as the demo background — visible as blank flashes
// before fetch + parent-walk filled them in.
//
// Fix being verified: VTR's hysteresis now holds the OLD cz until
// every visible tile at the target LOD is cached for this layer's
// slice (with a 5 s timeout safety net). The user keeps seeing the
// previous LOD over-zoomed during the hold instead of blank tiles.
//
// Detection: jump zoom from a settled value to a new value 3 LODs
// away in a single step. Inspect `_hysteresisZ` on each VTR a few
// frames later. With the gate, cz stays near the old LOD because
// the new LOD hasn't been fetched yet. Without the gate, cz
// advances all the way to the new round value within 1-2 frames.

import { test, expect } from '@playwright/test'

interface XgisMap {
  vtSources: Map<string, { renderer: { _hysteresisZ: number; getDrawStats?: () => { tilesVisible: number } } }>
  camera: { zoom: number }
}
declare global {
  interface Window { __xgisMap?: XgisMap; __xgisReady?: boolean }
}

test.describe('Zoom transition: hold previous LOD until next is ready', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('zoom-in jump 13 → 16: cz holds, advances only as cache fills', async ({ page }) => {
    test.setTimeout(60_000)

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

    const readCzs = async (): Promise<number[]> => {
      return await page.evaluate(() => {
        const map = window.__xgisMap
        if (!map?.vtSources) return []
        const out: number[] = []
        for (const { renderer } of map.vtSources.values()) out.push(renderer._hysteresisZ)
        return out
      })
    }

    const cz0 = await readCzs()
    console.log('[settled z=13] cz=', cz0)
    expect(Math.max(...cz0)).toBe(13)

    // Instant zoom jump 13 → 16. Without the gate, the next render
    // pass advances cz to 16 within 1-2 frames because the
    // hysteresis threshold (z > cz + 0.6) is satisfied for every
    // intermediate LOD. With the gate, cz holds at 13 because z=14
    // (let alone z=15/16) tiles aren't cached yet.
    await page.evaluate(() => {
      window.__xgisMap!.camera.zoom = 16
    })
    // ~150 ms ≈ 9 rAFs. The bug case lands at cz=16 well within
    // this window; the gate releases only when fetches complete,
    // which is much slower.
    await page.waitForTimeout(150)

    const czHold = await readCzs()
    console.log('[immediately after jump] cz=', czHold)
    expect(Math.max(...czHold)).toBeLessThan(16)

    await page.waitForTimeout(10_000)
    const czFinal = await readCzs()
    console.log('[after 10 s settle] cz=', czFinal)
    // Eventual consistency: cz advances once enough tiles cache.
    // 15 is acceptable (hysteresis lets cz=15 sit at zoom=16) but
    // we expect at least that.
    expect(Math.max(...czFinal)).toBeGreaterThanOrEqual(15)
  })

  test('zoom-out jump 16 → 13: cz holds, advances only as cache fills', async ({ page }) => {
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

    const readCzs = async (): Promise<number[]> => {
      return await page.evaluate(() => {
        const map = window.__xgisMap
        if (!map?.vtSources) return []
        const out: number[] = []
        for (const { renderer } of map.vtSources.values()) out.push(renderer._hysteresisZ)
        return out
      })
    }

    const cz0 = await readCzs()
    console.log('[settled z=16] cz=', cz0)
    expect(Math.min(...cz0)).toBe(16)

    // Jump down to 13. Without the gate, cz drops 16 → 13 within
    // 2-3 frames. With the gate, it holds wherever the next
    // ancestor isn't cached.
    await page.evaluate(() => {
      window.__xgisMap!.camera.zoom = 13
    })
    await page.waitForTimeout(150)

    const czHold = await readCzs()
    console.log('[immediately after jump] cz=', czHold)
    expect(Math.min(...czHold)).toBeGreaterThan(13)

    await page.waitForTimeout(10_000)
    const czFinal = await readCzs()
    console.log('[after 10 s settle] cz=', czFinal)
    expect(Math.min(...czFinal)).toBeLessThanOrEqual(14)
  })
})
