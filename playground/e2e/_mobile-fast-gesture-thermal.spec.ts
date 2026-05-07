// Reproduces user-reported thermal load: Korea zoom 7.7 (countrywide
// view), iPhone-class viewport, 10 s of fast continuous panning + bearing
// rotation. Inspector at this exact location showed:
//
//   GPU pass avg : 15.57 ms (60fps target threshold)
//   triangles    : 521 K / frame
//   drawn by zoom: z=3:9 z=7:9 z=8:12  ← z=3 is the smoking gun
//
// z=3 fallback = a single tile that covers all of Korea, hundreds of
// K of triangles dense polygon. Pre-fix the per-layer ancestor walk
// climbed unbounded (pz >= 0) and landed on it whenever a visible
// z=8 tile missed cache during gesture. Post-fix the walk is capped
// at currentZ - 2 on mobile, so far-ancestor draws cannot happen.
//
// This spec drives the same camera + gesture as the user reported and
// asserts: drawn z <= currentZ-3 == 0 across the entire 10 s window.
//
// Also captures peak triangles + drawn-by-zoom histogram so we can
// compare commit-by-commit.

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
  camera?: {
    zoom: number
    centerX: number
    centerY: number
    pitch?: number
    bearing?: number
  }
}
declare global {
  interface Window { __xgisMap?: XgisMap; __xgisReady?: boolean }
}

test.describe('Mobile fast-gesture thermal load', () => {
  test.use({ viewport: { width: 430, height: 715 } })

  test('Korea z=7.75: 10 s continuous pan + rotate, no far-ancestor fallback', async ({ page }) => {
    test.setTimeout(60_000)

    await page.goto(
      `/demo.html?id=pmtiles_layered#7.75/37.40304/127.50903/1.3/0`,
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
    // Initial settle so the catalog has *some* tiles cached at the
    // start of the gesture — this is a faithful repro of the user
    // scenario (they had been viewing the location, then started
    // moving fast).
    await page.waitForTimeout(2000)

    const result = await page.evaluate(async () => {
      const map = window.__xgisMap!
      const cam = map.camera!
      const cx0 = cam.centerX
      const cy0 = cam.centerY
      const startBearing = cam.bearing ?? 0

      // Web mercator metres per tile-unit at z=7.75 ≈ 156 km / px.
      // For the 430-wide viewport, half a viewport ≈ 33 km. We pan
      // back-and-forth across roughly half a viewport while spinning
      // the bearing — the "빙글빙글" motion the user described.
      const panRange = 50_000 // metres
      const durationMs = 10_000

      const peaks = {
        tilesVisible: 0,
        drawCalls: 0,
        triangles: 0,
      }
      // Aggregate drawn-by-zoom across the whole window — sum, not
      // peak. This is what scales the GPU vertex bandwidth load.
      const drawnByZoomSum = new Map<number, number>()
      const drawnByZoomPeakFrame = new Map<number, number>()
      const visibleByZoomSum = new Map<number, number>()
      let frames = 0
      let currentZ = -1

      const t0 = performance.now()
      while (performance.now() - t0 < durationMs) {
        await new Promise<void>(r => requestAnimationFrame(() => r()))
        const t = (performance.now() - t0) / durationMs
        // Sinusoid pan + linear bearing spin.
        cam.centerX = cx0 + Math.sin(t * Math.PI * 4) * panRange
        cam.centerY = cy0 + Math.cos(t * Math.PI * 3) * panRange * 0.6
        cam.bearing = startBearing + t * 720 // 2 full rotations

        for (const { renderer } of map.vtSources!.values()) {
          const ds = renderer.getDrawStats?.()
          if (ds) {
            if (ds.tilesVisible > peaks.tilesVisible) peaks.tilesVisible = ds.tilesVisible
            if (ds.drawCalls > peaks.drawCalls) peaks.drawCalls = ds.drawCalls
            if ((ds.triangles ?? 0) > peaks.triangles) peaks.triangles = ds.triangles ?? 0
          }
          const cz = renderer._hysteresisZ
          if (typeof cz === 'number') currentZ = cz
          const dz = renderer._frameDrawnByZoom
          if (dz) {
            for (const [z, n] of dz) {
              drawnByZoomSum.set(z, (drawnByZoomSum.get(z) ?? 0) + n)
              const peak = drawnByZoomPeakFrame.get(z) ?? 0
              if (n > peak) drawnByZoomPeakFrame.set(z, n)
            }
          }
          const visTiles = renderer._frameTileCache?.tiles
          if (visTiles) {
            for (const t of visTiles) {
              visibleByZoomSum.set(t.z, (visibleByZoomSum.get(t.z) ?? 0) + 1)
            }
          }
        }
        frames++
      }

      return {
        frames,
        durationMs,
        currentZ,
        peaks,
        drawnByZoomSum: Object.fromEntries(drawnByZoomSum),
        drawnByZoomPeakFrame: Object.fromEntries(drawnByZoomPeakFrame),
        visibleByZoomSum: Object.fromEntries(visibleByZoomSum),
      }
    })

    console.log('[fast-gesture]', result.frames, 'frames over', result.durationMs, 'ms')
    console.log('[fast-gesture currentZ at end]', result.currentZ)
    console.log('[fast-gesture peaks]', result.peaks)
    console.log('[fast-gesture drawn-by-zoom SUM across window]', result.drawnByZoomSum)
    console.log('[fast-gesture drawn-by-zoom peak/frame]', result.drawnByZoomPeakFrame)
    console.log('[fast-gesture VISIBLE-by-zoom SUM across window]', result.visibleByZoomSum)

    // Assertion 1: no far-ancestor fallback. With currentZ around 8,
    // anything drawn at z <= currentZ - 3 (i.e. z <= 5) is the
    // pathological single-tile-covers-Korea fallback.
    const cz = result.currentZ
    const farAncestorEntries = Object.entries(result.drawnByZoomSum)
      .filter(([z]) => Number(z) <= cz - 3)
      .map(([z, n]) => `z=${z}:${n}`)
    if (farAncestorEntries.length > 0) {
      console.log('[FAR-ANCESTOR FALLBACK]', farAncestorEntries.join(' '))
    }
    const farAncestorTotal = Object.entries(result.drawnByZoomSum)
      .filter(([z]) => Number(z) <= cz - 3)
      .reduce((s, [, n]) => s + (n as number), 0)
    expect(farAncestorTotal).toBe(0)
  })
})
