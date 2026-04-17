// Regression guard for the world-wrap bug fixed by pinning camera.centerX
// to a single world in XGISMap.renderFrame. Without the fix, panning past
// ±360° longitude at zoom 0 left a visible black gap on the far side of
// the camera because the quadtree tile selector rejected any `ox` outside
// the static `[-2, +3)` window — the camera's primary world drifted out
// from under it.
//
// Strategy:
//   1. Sample `tilesVisible` at a dozen longitudes across ±540°. Every
//      sample must draw the same number of tiles as the baseline at
//      centerLon=0 (5 copies at z=0 with a 1400px viewport); a drop
//      means one world copy is missing.
//   2. During a smooth pan across ±360°, the visible-tile count must
//      stay constant too.
//   3. Screenshots are saved for visual diffing but not asserted
//      per-pixel.

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART_DIR = join(HERE, '__worldwrap-z0__')
mkdirSync(ART_DIR, { recursive: true })

const VIEW = { width: 1400, height: 800 }

interface CameraProbe {
  centerX: number
  centerY: number
  zoom: number
  lon: number
  missedTiles: number
  tilesVisible: number
  rasterLoading: number
}

test('worldwrap at z=0 sweep', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize(VIEW)

  const consoleErrors: string[] = []
  const consoleWarns: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
    else if (m.type() === 'warning') consoleWarns.push(m.text())
  })

  await page.goto('/demo.html?id=minimal&e2e=1#0.00/0.00000/0.00', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 20_000 },
  )
  await page.waitForTimeout(1500) // let initial compile + tile loads finish

  // Probe: read camera + renderer state after the current frame lands.
  const probe = async (lon: number): Promise<CameraProbe> => {
    // Pan to the target longitude by writing camera.centerX directly (easier
    // than simulating wheel/drag for a precise sweep). The panzoom controller
    // doesn't clamp X, so this matches real user pan behaviour past ±180°.
    await page.evaluate((targetLon) => {
      const win = window as unknown as { __xgisMap?: { camera: { centerX: number; centerY: number; zoom: number } } }
      const map = win.__xgisMap
      if (!map) return
      const R = 6378137
      map.camera.centerX = targetLon * Math.PI / 180 * R
      map.camera.centerY = 0
      map.camera.zoom = 0
    }, lon)
    // Wait one rAF tick + a short settle so missedTiles can drain.
    await page.waitForTimeout(120)
    return await page.evaluate(() => {
      const win = window as unknown as {
        __xgisMap?: {
          camera: { centerX: number; centerY: number; zoom: number }
          _stats?: { get(): { tilesVisible?: number } }
          rasterRenderer?: { hasPendingLoads(): boolean; loadingTiles?: Map<unknown, unknown> }
          vtSources?: Map<string, { renderer: { getDrawStats(): { missedTiles: number; tilesVisible: number } } }>
        }
      }
      const m = win.__xgisMap!
      const R = 6378137
      const lon = (m.camera.centerX / R) * (180 / Math.PI)
      let missed = 0, vis = 0
      if (m.vtSources) {
        for (const [, { renderer }] of m.vtSources) {
          const st = renderer.getDrawStats()
          missed += st.missedTiles
          vis += st.tilesVisible
        }
      }
      const loadingSet = (m.rasterRenderer as unknown as { loadingTiles?: Map<unknown, unknown> } | undefined)?.loadingTiles
      const rasterLoading = loadingSet ? loadingSet.size : 0
      return {
        centerX: m.camera.centerX,
        centerY: m.camera.centerY,
        zoom: m.camera.zoom,
        lon,
        missedTiles: missed,
        tilesVisible: vis,
        rasterLoading,
      } as CameraProbe
    })
  }

  // Expose the map on window for probes. Done via the playground's
  // demo-runner normally, but let's also wire a direct handle from
  // inside the demo script so we don't depend on UI wiring.
  await page.evaluate(() => {
    const win = window as unknown as { __xgisMap?: unknown }
    // demo-runner already assigns this; guard just in case.
    if (!win.__xgisMap) {
      const el = document.querySelector('xgis-map') as unknown as { _map?: unknown } | null
      if (el && el._map) win.__xgisMap = el._map
    }
  })

  // Sweep from -540° to +540° in 60° steps (27 samples) — crosses the
  // ±180° seam three times in each direction.
  const samples: { lon: number; probe: CameraProbe }[] = []
  for (let lon = -540; lon <= 540; lon += 60) {
    const p = await probe(lon)
    samples.push({ lon, probe: p })
    const safeLon = lon.toString().replace('-', 'n').replace('.', 'p')
    const img = await page.screenshot()
    writeFileSync(join(ART_DIR, `lon-${safeLon}.png`), img)
  }

  // Also animate smoothly (rAF driven) to catch mid-motion glitches that
  // the discrete steps miss.
  const midMotionProbe = await page.evaluate(() => new Promise<{
    minVis: number; maxVis: number; framesWithMissed: number
  }>((resolve) => {
    const win = window as unknown as {
      __xgisMap?: {
        camera: { centerX: number }
        vtSources?: Map<string, { renderer: { getDrawStats(): { missedTiles: number; tilesVisible: number } } }>
      }
    }
    const map = win.__xgisMap!
    const R = 6378137
    const startLon = -360
    const endLon = 360
    const durationMs = 2000
    const t0 = performance.now()
    let minVis = Infinity, maxVis = -Infinity, framesWithMissed = 0
    function tick() {
      const t = performance.now()
      const u = Math.min(1, (t - t0) / durationMs)
      const lon = startLon + (endLon - startLon) * u
      map.camera.centerX = lon * Math.PI / 180 * R
      if (map.vtSources) {
        let vis = 0, missed = 0
        for (const [, { renderer }] of map.vtSources) {
          const st = renderer.getDrawStats()
          vis += st.tilesVisible
          missed += st.missedTiles
        }
        if (vis < minVis) minVis = vis
        if (vis > maxVis) maxVis = vis
        if (missed > 0) framesWithMissed++
      }
      if (u < 1) requestAnimationFrame(tick)
      else resolve({ minVis, maxVis, framesWithMissed })
    }
    requestAnimationFrame(tick)
  }))

  // Report
  const report = {
    view: VIEW,
    samples: samples.map(s => ({
      lon: s.lon,
      actualLon: Number(s.probe.lon.toFixed(4)),
      tilesVisible: s.probe.tilesVisible,
      missedTiles: s.probe.missedTiles,
      rasterLoading: s.probe.rasterLoading,
    })),
    midMotion: midMotionProbe,
    consoleErrors,
    consoleWarns: consoleWarns.filter(w => !w.includes('[vite]') && !w.includes('powerPreference')),
  }
  writeFileSync(join(ART_DIR, 'report.json'), JSON.stringify(report, null, 2))
  console.log('REPORT:', JSON.stringify(report, null, 2))

  // Baseline tile count at centerLon=0. Any sample that renders fewer
  // tiles than the baseline means a world copy fell off the quadtree —
  // the exact bug the camera-wrap guard was added to prevent.
  const baseline = samples.find(s => s.lon === 0)!.probe.tilesVisible
  expect(baseline).toBeGreaterThan(0)
  for (const { lon, probe } of samples) {
    expect.soft(probe.tilesVisible, `tilesVisible at lon=${lon}`).toBe(baseline)
    expect.soft(probe.missedTiles, `missedTiles at lon=${lon}`).toBe(0)
  }

  // Mid-motion must also hold a constant visible-tile count — a transient
  // dip during an animated pan is a softer regression than a discrete-
  // sample drop but still means a gap flashed on screen.
  expect.soft(midMotionProbe.minVis, 'mid-motion minVis').toBe(baseline)
  expect.soft(midMotionProbe.maxVis, 'mid-motion maxVis').toBe(baseline)
})
