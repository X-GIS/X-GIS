// Regression guard for fix(globe) commit 3eb9c11. Before the wire-in,
// production VTR used visibleTilesSSE / visibleTilesFrustum which
// don't understand sphere visibility — globe at the antimeridian
// (#2/0/180) rendered an almost-empty sphere because the mercator
// selectors only picked tiles near the camera's mercator-x position.
// PR #138 added `globeVisibleTiles` but the function had no
// production caller. This spec pins the wire-in by asserting the
// far-hemisphere geometry (Pacific landmass — Australia + NZ +
// Indonesia + Eastern Russia limb) actually paints when the camera
// faces lon=180.

import { test, expect } from '@playwright/test'

test('globe @ dateline renders the Pacific hemisphere', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1024, height: 720 })
  await page.goto('/demo.html?id=dark&proj=globe#2/0/180', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
  await page.waitForTimeout(2500)

  // Australia + NZ + Indonesia + Pacific island chains land in the
  // central + lower half of the canvas when looking at lon=180 / lat=
  // 0. Count slate-700-class fill pixels (dark.xgis renders countries
  // with `fill-slate-800 stroke-cyan-400`); slate-800 RGB ≈ (30,41,59).
  // Tolerance is loose because MSAA + log-depth blend dim it a little.
  const png = await page.locator('#map').screenshot({ type: 'png' })
  const dark = await page.evaluate(async (bytes) => {
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
    const data = ctx.getImageData(0, 0, w, h).data
    // Central 60×60% region — excludes UI chrome (zoom badge top-
    // left, snapshot button top-right, status bar bottom).
    const xMin = Math.floor(w * 0.20), xMax = Math.floor(w * 0.80)
    const yMin = Math.floor(h * 0.20), yMax = Math.floor(h * 0.80)
    let darkFill = 0
    for (let y = yMin; y < yMax; y++) {
      for (let x = xMin; x < xMax; x++) {
        const i = (y * w + x) * 4
        const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!
        // slate-700/800 family: low-saturation cool grey. r<70, g 30-80,
        // b 40-90 covers MSAA-blended variants of the slate fill.
        if (r < 70 && g >= 30 && g < 90 && b >= 40 && b < 100) darkFill++
      }
    }
    URL.revokeObjectURL(url)
    return darkFill
  }, Array.from(png))

  // Pre-wire-in baseline was effectively 0 (Pacific hemisphere
  // entirely empty, only Pacific-island stroke pixels of a few dots).
  // Post-fix Australia + NZ alone contribute many thousand. Threshold
  // sits well above any noise/AA bleed.
  expect(dark, `Pacific hemisphere appears empty (${dark} dark-fill px). ` +
    `globeVisibleTiles is probably not wired into vector-tile-renderer.ts.`)
    .toBeGreaterThan(1000)
})
