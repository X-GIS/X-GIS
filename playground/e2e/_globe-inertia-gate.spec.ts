import { test, expect } from '@playwright/test'

// #582 regression gate: a globe drag must not fling the camera with runaway inertia.
// Root cause was the inertia velocity being sampled via `unprojectToZ0` (the flat
// Mercator phantom plane, wrong on the sphere) in MERCATOR METRES, then fed to
// `camera.pan` which consumes CSS PIXELS — a small globe drag glided tens of degrees
// past the release point, so the user could not land on a target. The fix routes globe
// (like the disc family) through screen-px inertia velocity.
//
// This gate drags a small fixed pixel distance on a globe and asserts (a) the post-
// inertia pan is bounded and (b) the inertia GLIDE (post-release − at-release) is a
// small fraction of the drag — not the ~52° fling it was before.

test('globe drag inertia is bounded (#582)', async ({ page }) => {
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 20000 })
  await page.evaluate(() => (window as any).__xgisMap.setProjection('globe'))
  await page.waitForTimeout(700)

  const lon0 = await page.evaluate(
    () => ((window as any).__xgisMap.camera.centerX / 6378137) * (180 / Math.PI),
  )
  const box = (await page.locator('canvas').first().boundingBox())!
  const gx = box.x + box.width / 2 - 20,
    gy = box.y + box.height / 2

  await page.mouse.move(gx, gy)
  await page.mouse.down()
  for (let i = 1; i <= 4; i++) await page.mouse.move(gx + i * 5, gy, { steps: 1 })
  await page.mouse.up()
  const atRelease = await page.evaluate(
    () => ((window as any).__xgisMap.camera.centerX / 6378137) * (180 / Math.PI),
  )
  await page.waitForTimeout(450)
  const afterInertia = await page.evaluate(
    () => ((window as any).__xgisMap.camera.centerX / 6378137) * (180 / Math.PI),
  )

  const drag = Math.abs(atRelease - lon0)
  const glide = Math.abs(afterInertia - atRelease)
  // Pre-fix this 20px drag produced ~30° at release + ~52° of inertia (~82° total).
  // The drag itself is the grab-anchor (correct); the GLIDE is what regressed.
  expect(
    glide,
    `inertia glide ${glide.toFixed(1)}° must be a small fraction of the drag ${drag.toFixed(1)}°`,
  ).toBeLessThan(drag + 5)
  expect(Math.abs(afterInertia - lon0), 'total globe pan for a 20px drag is bounded').toBeLessThan(
    45,
  )
})
