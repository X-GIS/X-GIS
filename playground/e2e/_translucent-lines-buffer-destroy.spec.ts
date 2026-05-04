// Regression: 2026-05-04 user report. At
//   demo.html?id=translucent_lines#6.90/3.54771/116.46131/15.0/57.9
// the WebGPU validation hook reports
//   [X-GIS frame-validation] [Buffer "line-segments"] used in submit while destroyed.
// Cause: VectorTileRenderer.evictGPUTiles() runs at the end of render(),
// which is invoked multiple times per frame by the bucket scheduler
// (opaque + per-translucent-layer). Eviction in call N can destroy a
// tile bound by encoded-but-not-yet-submitted commands from call N−1
// or N (fallback paths the stableKeys check misses). Fix: defer
// eviction to the start of the next beginFrame() — same pattern the
// file already uses for `retiredUniformRings`.

import { test, expect, type Page } from '@playwright/test'

const READY_TIMEOUT_MS = 15_000

async function waitForXgisReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: READY_TIMEOUT_MS },
  )
}

test('translucent_lines: no "Buffer used in submit while destroyed" during pan', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 720 })

  const validationErrors: string[] = []
  page.on('console', m => {
    if (m.type() === 'error' && m.text().includes('frame-validation')) {
      validationErrors.push(m.text())
    }
  })

  // The user-reported camera state.
  await page.goto(
    '/demo.html?id=translucent_lines#6.90/3.54771/116.46131/15.0/57.9',
    { waitUntil: 'domcontentloaded' },
  )
  await waitForXgisReady(page)
  await page.waitForTimeout(5000) // long settle to surface initial-burst races

  // Drive the camera in a jitter loop. Each setView shifts the visible
  // tile set slightly, forcing tiles in/out of the cache and triggering
  // eviction repeatedly across frames. ~30 iterations × 100 ms = 3 s of
  // sustained tile churn — empirically enough to flood the validation
  // log pre-fix.
  // Drive the camera through enough motion to overflow the 512-tile
  // cache and force evictGPUTiles() to run repeatedly. Wide zoom-range
  // sweep across hemispheres, repeated bearing/pitch jitter, sustained
  // for ~10 s.
  const cacheTrace = await page.evaluate(async () => {
    const map = (window as unknown as { __xgisMap?: any }).__xgisMap
    if (!map) throw new Error('__xgisMap missing')
    const cam = map.camera
    const lonLatToMercator = (lon: number, lat: number): [number, number] => {
      const R = 6378137
      const DEG2RAD = Math.PI / 180
      const cl = Math.max(-85.0511, Math.min(85.0511, lat))
      return [lon * DEG2RAD * R, Math.log(Math.tan(Math.PI / 4 + cl * DEG2RAD / 2)) * R]
    }
    const trace: number[] = []
    const targets: Array<[number, number, number, number, number]> = [
      // [lon, lat, zoom, bearing, pitch]
      [116.46, 3.54, 6.9, 15, 57.9],
      [120, 30, 5, 90, 60],
      [-120, -30, 7, 180, 70],
      [10, 50, 8, 270, 50],
      [-60, 40, 6, 45, 65],
      [180, 0, 7.5, 135, 75],
      [0, -45, 5.5, 225, 55],
      [60, 60, 8.5, 0, 40],
    ]
    for (let cycle = 0; cycle < 4; cycle++) {
      for (const [lon, lat, zoom, bearing, pitch] of targets) {
        const [mx, my] = lonLatToMercator(lon, lat)
        cam.centerX = mx
        cam.centerY = my
        cam.zoom = zoom
        cam.bearing = bearing
        cam.pitch = pitch
        map.invalidate()
        await new Promise(r => setTimeout(r, 200))
        const pipe = map.inspectPipeline?.()
        if (pipe?.sources) {
          for (const s of pipe.sources) trace.push(s.cache?.size ?? 0)
        }
      }
    }
    return { maxCache: Math.max(...trace), traceLen: trace.length }
  })
  await page.waitForTimeout(500)

  console.log(`[buffer-destroy-repro] cache peak: ${cacheTrace.maxCache} (samples: ${cacheTrace.traceLen})`)
  if (validationErrors.length > 0) {
    console.log(`[buffer-destroy-repro] ${validationErrors.length} validation errors:`)
    for (const e of validationErrors.slice(0, 5)) console.log(`  ${e}`)
  }
  expect(validationErrors, 'frame-validation errors during translucent_lines pan').toEqual([])
})
