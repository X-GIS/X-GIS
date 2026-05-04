// Regression: 2026-05-04 user report at
//   demo.html?id=multi_layer#4.70/44.63745/109.94708
// WebGPU validation flooded with
//   [X-GIS frame-validation] Destroyed texture [Texture (unlabeled
//     256x256 px, TextureFormat::RGBA8Unorm)] used in a submit.
// Same lifecycle hazard as the buffer fix (da4f26f) but for raster
// tile textures. RasterRenderer.evictTiles() destroys textures
// inline at the end of render() — bind groups created earlier in
// the same frame still reference them at queue.submit() time.

import { test, expect, type Page } from '@playwright/test'

const READY_TIMEOUT_MS = 15_000

async function waitForXgisReady(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: READY_TIMEOUT_MS },
  )
}

test('multi_layer raster: no destroyed-texture validation errors during pan', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 720 })

  const validationErrors: string[] = []
  page.on('console', m => {
    if (m.type() === 'error' && m.text().includes('frame-validation')) {
      validationErrors.push(m.text())
    }
  })

  await page.goto(
    '/demo.html?id=multi_layer#4.70/44.63745/109.94708',
    { waitUntil: 'domcontentloaded' },
  )
  await waitForXgisReady(page)
  await page.waitForTimeout(2000)

  // Pan + zoom across many positions to force raster tile churn past the
  // cache cap, triggering evictTiles() repeatedly.
  await page.evaluate(async () => {
    const map = (window as unknown as { __xgisMap?: any }).__xgisMap
    const cam = map.camera
    const R = 6378137, DEG2RAD = Math.PI / 180
    const targets: Array<[number, number, number]> = [
      [109.94, 44.63, 4.7],
      [120, 30, 5.5],
      [100, 50, 6.0],
      [115, 35, 5.0],
      [90, 40, 6.5],
      [130, 25, 7.0],
      [105, 45, 5.5],
      [85, 55, 6.0],
    ]
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const [lon, lat, zoom] of targets) {
        cam.centerX = lon * DEG2RAD * R
        const cl = Math.max(-85.0511, Math.min(85.0511, lat))
        cam.centerY = Math.log(Math.tan(Math.PI / 4 + cl * DEG2RAD / 2)) * R
        cam.zoom = zoom
        map.invalidate()
        await new Promise(r => setTimeout(r, 200))
      }
    }
  })
  await page.waitForTimeout(500)

  if (validationErrors.length > 0) {
    console.log(`[raster-destroy-repro] ${validationErrors.length} validation errors:`)
    for (const e of validationErrors.slice(0, 5)) console.log(`  ${e}`)
  }
  expect(validationErrors, 'frame-validation errors during multi_layer pan').toEqual([])
})
