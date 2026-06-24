import { test, expect } from '@playwright/test'

// Regression smoke: the Tile uniform struct grew (+uv_rect) and is SHARED by
// normal raster tiles. Confirm a flat-mercator raster demo still renders a
// non-blank canvas with no errors (uv_rect defaults to (0,0,1,1) ⇒ identical).
test('normal raster still renders after Tile struct change', async ({ page }) => {
  test.setTimeout(45_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  await page.setViewportSize({ width: 800, height: 800 })
  await page.goto('/demo.html?id=openfreemap_bright&e2e=1#2/30/10', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 25_000 },
  )
  await page.waitForTimeout(3500)

  // Non-blank: count non-near-black pixels in the canvas via a 2D readback is
  // unreliable for WebGPU; instead assert the screenshot has visible variance.
  const shot = await page.locator('#map').screenshot()
  // crude: PNG of a blank dark canvas is tiny; a rendered map is much larger.
  console.log('raster smoke: errors =', errors.length, 'png bytes =', shot.length, errors.slice(0, 3).join(' || '))
  expect(errors.length).toBe(0)
  expect(shot.length).toBeGreaterThan(15000) // a rendered map PNG is well above this
})
