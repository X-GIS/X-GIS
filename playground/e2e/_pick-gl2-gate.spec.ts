// ═══ #834 M5 slice 6 ACCEPTANCE GATE — pickAt on the WebGL2 backend ═══
//
// Mirrors _pick-e2e on ?forcegl2=1: multi_layer at world view, a 5×5 grid of
// pickAt samples, expecting hits with non-zero featureIds over land and
// multiple distinct ids. This proves the whole WebGL2 pick chain in one run:
// the pick-enabled polygon GLSL twin (colour + rg32uint MRT outputs), the
// on-demand offscreen MRT pass (beginOffscreenPass with an integer attachment
// + depth-stencil), the per-show pick_id tile-slot write, the synchronous
// readPixelRg32ui readback with the bottom-up row flip, and the
// interaction-controller's webgl2 branch decode + resolve.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less.

import { test, expect } from '@playwright/test'

test('pickAt returns feature IDs on WebGl2Device (?forcegl2=1)', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/demo.html?id=multi_layer&e2e=1&picking=1&forcegl2=1#1.5/20/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
  // Let the tiles converge at SwiftShader speed before sampling.
  await page.waitForTimeout(9000)
  await page.evaluate(() => (window as any).__xgisMap?.invalidate?.())
  await page.waitForTimeout(1500)

  const results = await page.evaluate(async () => {
    const m = (window as any).__xgisMap
    const canvas = document.querySelector('#map') as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    const samples: Array<{ x: number; y: number; result: unknown }> = []
    for (let iy = 1; iy <= 5; iy++) {
      for (let ix = 1; ix <= 5; ix++) {
        const x = rect.left + (rect.width * ix) / 6
        const y = rect.top + (rect.height * iy) / 6
        const result = await m.pickAt(x, y)
        samples.push({ x, y, result })
      }
    }
    return samples
  })

  const hits = results.filter((s) => s.result !== null)
  console.log(
    `[pick-gl2] hits: ${hits.length}/${results.length}`,
    hits
      .slice(0, 6)
      .map((h) => JSON.stringify(h.result))
      .join(' '),
  )
  expect(errors, 'no page/console errors').toEqual([])
  // Same floor as the WebGPU gate: land covers enough of the world view that
  // ≥5 of 25 samples must land on a country fill.
  expect(hits.length).toBeGreaterThanOrEqual(5)
  for (const h of hits) {
    const r = h.result as { featureId: number }
    expect(r.featureId).toBeGreaterThan(0)
  }
  const uniqueIds = new Set(hits.map((h) => (h.result as { featureId: number }).featureId))
  expect(uniqueIds.size).toBeGreaterThanOrEqual(2)
})
