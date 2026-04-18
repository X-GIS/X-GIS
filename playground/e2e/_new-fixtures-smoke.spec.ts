// Smoke test for the 5 coverage-gap fixtures added this session. Each
// must reach __xgisReady without error and paint a non-empty canvas.
// Prefixed with `_` so it stays a diagnostic — the main smoke sweep in
// fixtures.spec.ts already has broader assertions.

import { test, expect } from '@playwright/test'

const NEW_FIXTURES = [
  'fixture_cap_arrow',
  'fixture_anchor_bottom',
  'fixture_projection_orthographic',
  'fixture_projection_natural_earth',
  'fixture_zoom_opacity',
] as const

for (const id of NEW_FIXTURES) {
  test(`new fixture loads: ${id}`, async ({ page }) => {
    test.setTimeout(20_000)
    await page.setViewportSize({ width: 800, height: 600 })
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    await page.goto(`/demo.html?id=${id}&e2e=1`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 15_000 },
    )
    // Let the render loop tick once more so anything from the first
    // frame is definitely on the compositor before we screenshot.
    await page.waitForTimeout(300)
    // A blank canvas usually indicates the WGSL path for this fixture
    // silently rejected the input; painted pixels mean the path ran.
    // WebGPU canvases can't be read back via drawImage after the frame
    // is submitted, so we use Playwright's screenshot (which captures
    // the composited output from the browser) and scan for non-background
    // pixels in the canvas region.
    const png = await page.locator('#map').screenshot()
    const painted = await page.evaluate(async (b64) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then(r => r.blob())
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width; c.height = bmp.height
      const ctx2 = c.getContext('2d')!
      ctx2.drawImage(bmp, 0, 0)
      const d = ctx2.getImageData(0, 0, bmp.width, bmp.height).data
      let nonBlack = 0
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) nonBlack++
      }
      return nonBlack
    }, png.toString('base64'))
    // Filter out the "404 countries-sample.geojson" style errors that
    // some fixtures legitimately produce when their inline data path
    // doesn't resolve — not a regression of the fixture itself.
    const realErrors = errors.filter(e => !/404|countries-sample|Failed to load/.test(e))
    expect(realErrors, `errors: ${realErrors.join(' | ')}`).toHaveLength(0)
    expect(painted, 'canvas should paint non-background pixels').toBeGreaterThan(100)
  })
}
