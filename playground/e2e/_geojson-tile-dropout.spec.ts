// Regression for the GeoJSON tile-dropout bug reported 2026-05-12.
//
// Repro URL (deployed site, same setup as `playground demo.html`):
//   /play/demo.html?id=styled_world#7.06/37.13808/126.52451/352.4/8.7
//
// User-visible symptom: zooming into the Yellow Sea between China and
// Korea (Incheon-ish) at z≈7 paints individual ocean tiles in the
// expected sky-950 fill, but adjacent tiles drop out entirely —
// background (dark slate) bleeds through diagonal tile boundaries.
// Multiple GeoJSON sources affected (ne_110m_ocean / land / countries
// all show similar fragmentation), so the failure is in the in-memory
// tile compilation path, not in any one dataset.
//
// Suspected root cause (compiler/src/tiler/clip.ts:13
// clipPolygonToRect): Sutherland-Hodgman edge-case when a polygon
// (e.g. world-wrapping ocean) entirely contains a sub-tile rect and
// has zero ring vertices anywhere near the rect. The 4-pass clip-
// against-edges should produce the rect as output, but some
// combination of bbox-intersection + per-ring drop-if-<3-vertices
// drops the only ring before the rect can be synthesised.
//
// This spec fires the existing playground demo at the exact user
// camera + asserts the rendered canvas is "mostly ocean blue" with
// no large dark gaps where the ocean polygon should be. Failure
// pattern: dark-pixel ratio > 5 % (vs healthy < 1 %).

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__geojson-tile-dropout__')
mkdirSync(ART, { recursive: true })

test.skip('GeoJSON ocean tiles render contiguously at z=7 near Korea (Yellow Sea)', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 900, height: 1200 })

  await page.goto(
    '/demo.html?id=styled_world#7.06/37.13808/126.52451/352.4/8.7',
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // Generous settle for the in-memory tile compile cascade.
  await page.waitForTimeout(4_000)

  const png = await page.locator('canvas').first().screenshot()
  writeFileSync(join(ART, 'yellow-sea-dropout.png'), png)

  // Sample the canvas: count ocean-blue (sky-950 ≈ #082f49) vs background
  // (dark slate). The view at z=7 over the Yellow Sea is ≥ 90 % water by
  // area; on a healthy render the ocean fill dominates.
  const stats = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas')!
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), 'image/png'),
    )
    if (!blob) return { error: 'no blob' }
    const buf = await blob.arrayBuffer()
    const img = new Image()
    img.src = URL.createObjectURL(new Blob([buf], { type: 'image/png' }))
    await new Promise<void>((res, rej) => {
      img.onload = () => res(); img.onerror = () => rej(new Error('decode'))
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height).data
    let oceanBlue = 0, darkGap = 0, total = 0
    for (let i = 0; i < data.length; i += 4) {
      total++
      const r = data[i], g = data[i + 1], b = data[i + 2]
      // sky-950 #082f49 — wide tolerance for GPU blending.
      if (r < 40 && g >= 35 && g <= 80 && b >= 60 && b <= 100) oceanBlue++
      // background gap — near-black slate.
      else if (r < 35 && g < 35 && b < 40) darkGap++
    }
    return { total, oceanBlue, darkGap }
  })

  if ('error' in stats) throw new Error(stats.error)
  // eslint-disable-next-line no-console
  console.log('[yellow-sea-dropout]', stats)

  const darkRatio = stats.darkGap / stats.total
  // Healthy: ocean fills the view → dark < 1 %. Bug: 5-30 % depending
  // on which tiles drop. Threshold chosen above current observed bug
  // floor so a partial regression still trips.
  expect(darkRatio, `dark-gap ratio ${(darkRatio * 100).toFixed(1)}%`).toBeLessThan(0.03)
})
