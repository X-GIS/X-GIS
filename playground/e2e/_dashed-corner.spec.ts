// Bug capture — `dashed_borders` demo, sharp-corner pixel sampling.
//
// Reported state: at zoom ~6.35 over Egypt (#6.35/26.57533/28.81851)
// the dashed border pattern fails near tile-clipped corners — a
// horizontal segment along (or close to) a tile boundary renders as
// SOLID white instead of dashed.
//
// Suspected root cause:
//   1. Polygon clipping at the tile boundary produces synthetic edges
//      whose `arc_start` (computed by the BFS chain walker in
//      buildLineSegments) restarts at 0 inside the clipped tile, so
//      the dash phase begins in the "on" portion.
//   2. With dash 8px on / 4px off and mpp ~1644 m/px at this zoom,
//      one cycle is ~19.7 km — long enough that any synthetic edge
//      shorter than 13 km lies entirely in the "on" half.
//
// Test strategy: load the URL, scan EVERY canvas row for the row with
// the most stroke-coloured (white) pixels — that's almost certainly
// the buggy horizontal segment. Then count on/off transitions on that
// row. A correctly-dashed line shows many alternations; a solid line
// shows ≤ 2.
//
// Marked `test.fixme` because pixel-scanning in headless Chromium
// doesn't reliably catch the buggy/fixed state on this dev machine —
// the rendered stroke pixels are too thin / too dim to threshold
// confidently across environments. The underlying invariant (global
// arc continuity across tile boundaries) is unit-tested in
// compiler/src/__tests__/polygon-outline-arc-continuity.test.ts,
// which directly inspects the tiler output without the GPU round-trip.
// REMOVE `.fixme` and run locally to capture the visible symptom for
// validation when the rendering path is changed.

import { test, expect } from '@playwright/test'

test.fixme('dashed_borders — sharp-corner segments carry the dash pattern', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/demo.html?id=dashed_borders&e2e=1#6.35/26.57533/28.81851', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
  await page.waitForTimeout(2500)

  const result = await page.evaluate(() => {
    const c = document.querySelector('#map') as HTMLCanvasElement
    const off = document.createElement('canvas')
    off.width = c.width
    off.height = c.height
    const ctx = off.getContext('2d')!
    ctx.drawImage(c, 0, 0)
    const full = ctx.getImageData(0, 0, c.width, c.height).data

    // Find the row with the most stroke-coloured (white) pixels — that's
    // the candidate horizontal stroke whose dashing we want to inspect.
    let bestRow = 0
    let bestBright = 0
    const rowBright = (y: number) => {
      let n = 0
      const row = y * c.width * 4
      for (let x = 0; x < c.width; x++) {
        const r = full[row + x * 4], g = full[row + x * 4 + 1], b = full[row + x * 4 + 2]
        const lum = 0.299 * r + 0.587 * g + 0.114 * b
        if (lum > 180) n++
      }
      return n
    }
    for (let y = 0; y < c.height; y++) {
      const n = rowBright(y)
      if (n > bestBright) { bestBright = n; bestRow = y }
    }

    // Count on/off transitions on that row. Also report the maximum
    // run-length of bright pixels (a solid line has one giant run).
    const row = bestRow * c.width * 4
    let transitions = 0
    let prevBright = false
    let maxRun = 0
    let curRun = 0
    for (let x = 0; x < c.width; x++) {
      const r = full[row + x * 4], g = full[row + x * 4 + 1], b = full[row + x * 4 + 2]
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      const bright = lum > 180
      if (bright) { curRun++; if (curRun > maxRun) maxRun = curRun }
      else { curRun = 0 }
      if (bright !== prevBright) transitions++
      prevBright = bright
    }
    return { bestRow, brightCount: bestBright, transitions, maxRun, canvasW: c.width }
  })

  console.log('[dashed-corner]', JSON.stringify(result))

  // Sanity: did we even find a stroke? If the camera isn't drawing
  // anything bright, the test is uninformative — skip rather than fail.
  test.skip(result.brightCount < 30, 'No stroke pixels visible at this camera state — check URL/data')

  // A correctly-dashed line shows many alternations and short runs.
  // A solid line shows ≤ 2 transitions and one long run (~brightCount).
  // Threshold: at least 4 transitions AND no single run > 60% of the
  // total bright pixels (rules out "one giant solid stroke").
  expect(result.transitions).toBeGreaterThanOrEqual(4)
  expect(result.maxRun).toBeLessThan(result.brightCount * 0.6)
})
