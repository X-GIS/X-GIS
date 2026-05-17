// Regression: single-point GeoJSON sources (lonSpan === latSpan === 0)
// fed `Math.log2(360 / (degPerPx * 256))` Infinity because degPerPx
// collapses to 0, and `camera.zoom = Infinity` produces a NaN/Infinity
// projection matrix → completely blank canvas with a `#Infinity/0/0`
// badge. Symptom found across fixture_size_zoom / fixture_anchor_*
// (every fixture using fixture-point.geojson — a 1-point file).
//
// The fix replaces the auto-fit zoom with a sensible default when
// bounds are degenerate. This spec pins both contracts: zoom is
// finite, and the canvas paints something (the SDF point billboard).

import { test, expect } from '@playwright/test'

const SINGLE_POINT_FIXTURES = [
  'fixture_anchor_center',
  'fixture_anchor_top',
  'fixture_anchor_bottom',
  'fixture_flat_anchor_bottom',
  'fixture_size_zoom',
  'fixture_shape_custom_svg',
]

// All single-point fixtures now paint at the bounds-fit zoom. (The
// fixture_size_zoom skip lived here for a separate
// zoom-interpolated-size routing bug — fixed in
// vector-tile-renderer.ts:hasPointStyle, see
// _zoom-interp-point-size.spec.ts.)
const SKIP_PAINT_CHECK = new Set<string>()

for (const id of SINGLE_POINT_FIXTURES) {
  test(`${id}: camera.zoom is finite after bounds-fit`, async ({ page }) => {
    test.setTimeout(20_000)
    await page.setViewportSize({ width: 1024, height: 720 })
    await page.goto(`/demo.html?id=${id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 15_000 },
    )
    // Bounds-fit fires after the GeoJSON compile promise resolves —
    // give it a beat post-ready.
    await page.waitForTimeout(800)

    const zoom = await page.evaluate(() => {
      const m = (window as unknown as { __xgisMap?: { camera: { zoom: number } } }).__xgisMap
      return m?.camera.zoom ?? null
    })
    expect(zoom, `${id}: zoom should be finite, got ${zoom}`).not.toBeNull()
    expect(Number.isFinite(zoom!), `${id}: zoom is non-finite (${zoom})`).toBe(true)
  })

  const paintTest = SKIP_PAINT_CHECK.has(id) ? test.skip : test
  paintTest(`${id}: canvas paints the point billboard`, async ({ page }) => {
    test.setTimeout(20_000)
    await page.setViewportSize({ width: 1024, height: 720 })
    await page.goto(`/demo.html?id=${id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 15_000 },
    )
    await page.waitForTimeout(1500)

    const png = await page.locator('#map').screenshot({ type: 'png' })
    // The fixtures use a mix of rose-500 / amber-400 (and one with a
    // white stroke). Count any saturated non-background pixel inside
    // the central 30 %×30 % region, where the billboard at the
    // bounds-fit centre actually lands. UI chrome (zoom badge top-
    // left, snapshot button top-right, status bar bottom) sits well
    // outside that window so it can't inflate the count.
    const pointPx = await page.evaluate(async (bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const url = URL.createObjectURL(blob)
      const img = new Image()
      await new Promise<void>((res, rej) => {
        img.onload = () => res(); img.onerror = () => rej(new Error('img'))
        img.src = url
      })
      const off = new OffscreenCanvas(img.width, img.height)
      const ctx = off.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const w = img.width, h = img.height
      const xMin = Math.floor(w * 0.35), xMax = Math.floor(w * 0.65)
      const yMin = Math.floor(h * 0.35), yMax = Math.floor(h * 0.65)
      const data = ctx.getImageData(0, 0, w, h).data
      let n = 0
      for (let y = yMin; y < yMax; y++) {
        for (let x = xMin; x < xMax; x++) {
          const i = (y * w + x) * 4
          const r = data[i], g = data[i + 1], b = data[i + 2]
          if (r > 60 || g > 60 || b > 80) n++  // anything above dark bg
        }
      }
      URL.revokeObjectURL(url)
      return n
    }, Array.from(png))
    expect(pointPx, `${id}: SDF point billboard not visible in centre (pixels: ${pointPx})`).toBeGreaterThan(50)
  })
}
