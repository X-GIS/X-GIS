// Regression: a layer that declares `size-[interpolate(zoom, …)]` for
// SDF points did not render any point at all. Root cause:
// VectorTileRenderer's `hasPointStyle` gate at
// vector-tile-renderer.ts only checked `show.size !== null ||
// show.shape !== null || show.sizeExpr !== null`. Zoom-interpolated
// (and time-interpolated) sizes land in `show.paintShapes.size`
// instead — `show.size` stays null because the static-only branch in
// emit-commands.ts:403 (`size: node.size.kind === 'constant' ? value
// : null`) explicitly nulls it. So zoom-interp size flowed past the
// gate as "no point style" and the points were never drawn.
//
// fixture_size_zoom is the canonical repro:
//   layer dot {
//     source: p
//     | fill-rose-500
//     | size-[interpolate(zoom, 0, 30, 20, 80)]
//   }

import { test, expect } from '@playwright/test'

test('fixture_size_zoom paints a rose-coloured point (zoom-interp size)', async ({ page }) => {
  test.setTimeout(20_000)
  await page.setViewportSize({ width: 1024, height: 720 })
  await page.goto('/demo.html?id=fixture_size_zoom', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
  await page.waitForTimeout(1500)

  // Camera-finite sanity (Infinity-zoom fix from earlier session).
  const zoom = await page.evaluate(() =>
    (window as unknown as { __xgisMap?: { camera: { zoom: number } } }).__xgisMap?.camera.zoom)
  expect(Number.isFinite(zoom!)).toBe(true)

  // The actual contract: at the bounds-fit zoom (z=4 for a single
  // point), `interpolate(zoom, 0, 30, 20, 80)` resolves to 40 px and
  // the billboard MUST appear. Count saturated rose-class pixels
  // (244,63,94 ≈ rose-500) inside the centre 30×30 % region.
  const png = await page.locator('#map').screenshot({ type: 'png' })
  const rosePx = await page.evaluate(async (bytes) => {
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
        if (r > 180 && g < 130 && b > 50 && b < 160) n++
      }
    }
    URL.revokeObjectURL(url)
    return n
  }, Array.from(png))
  expect(rosePx, `Zoom-interp point billboard missing: ${rosePx} rose pixels`).toBeGreaterThan(100)
})
