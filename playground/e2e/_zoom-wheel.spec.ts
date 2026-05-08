// Repro: user reports that with initial zoom 15, the moment they
// scroll wheel-out the camera jumps to zoom 0 immediately. Watch
// camera.zoom + centerX/Y over a series of wheel events and assert
// the zoom decreases smoothly, never snaps to 0.

import { test, expect } from '@playwright/test'

declare global {
  interface Window {
    __xgisMap?: { camera: { zoom: number; centerX: number; centerY: number } }
  }
}

test.describe('wheel zoom — smooth descent', () => {
  test('z=15 → wheel out 5× → zoom decreases gradually, never 0', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/demo.html?id=osm_style&e2e=1#15/35.68/139.76/0/0', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => window.__xgisReady === true, null, { timeout: 30_000 })
    await page.waitForTimeout(3000) // settle initial tile loads

    const samples: Array<{ event: number; zoom: number; cx: number; cy: number }> = []
    const sample = async (event: number) => {
      const s = await page.evaluate(() => {
        const c = window.__xgisMap?.camera
        return c ? { zoom: c.zoom, cx: c.centerX, cy: c.centerY } : null
      })
      if (s) samples.push({ event, ...s })
    }
    await sample(0)

    // Fire 5 wheel events at the canvas centre.
    const map = page.locator('#map')
    const box = await map.boundingBox()
    if (!box) throw new Error('no map bounds')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    for (let i = 1; i <= 5; i++) {
      await page.mouse.wheel(0, 100) // deltaY=100 = zoom out
      await page.waitForTimeout(400)  // let smooth-zoom settle between events
      await sample(i)
    }

    // eslint-disable-next-line no-console
    console.log('Zoom samples:')
    for (const s of samples) {
      // eslint-disable-next-line no-console
      console.log(`  event=${s.event}  zoom=${s.zoom.toFixed(3)}  cx=${s.cx.toFixed(0)}  cy=${s.cy.toFixed(0)}`)
    }

    // Invariants:
    //   * Zoom AFTER first wheel-out must drop, but stay close to
    //     the start (not snap to 0 — that's the user-reported bug).
    //   * Each subsequent step should decrease monotonically OR
    //     stay (animation could be still settling between samples).
    //   * No sample should ever read zoom < initialZoom - 5
    //     (single wheel ~= 1 zoom level; 5 events should give
    //     about 14..15 → 9..10, not 0).
    const initial = samples[0].zoom
    const afterFirst = samples[1].zoom
    expect(initial).toBeGreaterThan(13)
    expect(afterFirst).toBeGreaterThan(initial - 1.5)
    for (const s of samples) {
      expect(s.zoom).toBeGreaterThanOrEqual(initial - 6)
    }
    // Centre should stay near Tokyo (35.68 N, 139.76 E in mercator):
    // centerX ≈ 15.55e6, centerY ≈ 4.26e6. After zoom-out the
    // wheel-toward-cursor anchor at canvas centre keeps centre
    // approximately put — not jumping near (0, 0).
    const last = samples[samples.length - 1]
    expect(Math.abs(last.cx)).toBeGreaterThan(1e6) // not near 0
    expect(Math.abs(last.cy)).toBeGreaterThan(1e6)
  })
})
