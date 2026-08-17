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

// Dark-fill pixels required before the far hemisphere counts as painted.
// Australia + NZ alone contribute many thousand; the threshold sits well
// above any noise / AA bleed.
const DARK_FILL_MIN = 1000

test('globe @ dateline renders the Pacific hemisphere', async ({ page }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1024, height: 720 })
  await page.goto('/demo.html?id=dark&proj=globe#2/0/180', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 15_000 },
  )

  // Australia + NZ + Indonesia + Pacific island chains land in the
  // central + lower half of the canvas when looking at lon=180 / lat=
  // 0. Count slate-700-class fill pixels (dark.xgis renders countries
  // with `fill-slate-800 stroke-cyan-400`); slate-800 RGB ≈ (30,41,59).
  // Tolerance is loose because MSAA + log-depth blend dim it a little.
  const sampleDarkFill = async (): Promise<number> => {
    const png = await page.locator('#map').screenshot({ type: 'png' })
    return page.evaluate(async (bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const url = URL.createObjectURL(blob)
      const img = new Image()
      await new Promise<void>((res, rej) => {
        img.onload = () => res()
        img.onerror = () => rej(new Error('img'))
        img.src = url
      })
      const off = new OffscreenCanvas(img.width, img.height)
      const ctx = off.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const w = img.width,
        h = img.height
      const data = ctx.getImageData(0, 0, w, h).data
      // Central 60×60% region — excludes UI chrome (zoom badge top-
      // left, snapshot button top-right, status bar bottom).
      const xMin = Math.floor(w * 0.2),
        xMax = Math.floor(w * 0.8)
      const yMin = Math.floor(h * 0.2),
        yMax = Math.floor(h * 0.8)
      let darkFill = 0
      for (let y = yMin; y < yMax; y++) {
        for (let x = xMin; x < xMax; x++) {
          const i = (y * w + x) * 4
          const r = data[i]!,
            g = data[i + 1]!,
            b = data[i + 2]!
          // slate-700/800 family: low-saturation cool grey. r<70, g 30-80,
          // b 40-90 covers MSAA-blended variants of the slate fill.
          if (r < 70 && g >= 30 && g < 90 && b >= 40 && b < 100) darkFill++
        }
      }
      URL.revokeObjectURL(url)
      return darkFill
    }, Array.from(png))
  }

  // Poll rather than sample once at a fixed delay. `__xgisReady` fires when the
  // map is live, NOT when it has painted: measured on the software rasterizer
  // (XGIS_SOFTWARE_GPU=1) this page reports ready at ~3 s and the canvas is
  // still ENTIRELY unpainted — not merely fill-less, zero non-background pixels
  // in the sampled region — at +6 s and +9 s, reaching its steady 6.6k dark-fill
  // px only around +35 s, because the `dark` demo compiles a 14.6 MB
  // countries.geojson before the first tile can draw. The former fixed
  // `waitForTimeout(2500)` therefore read the frame before anything existed and
  // reported 0, a coin-flip that fails on origin/main as readily as on any
  // branch (measured 4 of 6 runs at merge-base e44611b8).
  //
  // This does NOT weaken the gate: the threshold below is unchanged, the loop
  // never breaks under it, and a hemisphere that genuinely does not paint stays
  // at 0 for the whole budget and still fails — it only stops the spec
  // concluding "empty" from a frame that had not been rendered yet.
  const deadline = Date.now() + 120_000
  let dark = 0
  for (;;) {
    dark = await sampleDarkFill()
    if (dark > DARK_FILL_MIN || Date.now() > deadline) break
    await page.waitForTimeout(1000)
  }

  // Pre-wire-in baseline was effectively 0 (Pacific hemisphere
  // entirely empty, only Pacific-island stroke pixels of a few dots).
  expect(
    dark,
    `Pacific hemisphere appears empty (${dark} dark-fill px). ` +
      `globeVisibleTiles is probably not wired into vector-tile-renderer.ts.`,
  ).toBeGreaterThan(DARK_FILL_MIN)
})
