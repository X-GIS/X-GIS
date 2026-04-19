// End-to-end pickAt test — hover various points on multi_layer and
// assert the returned feature IDs are plausible (non-zero over
// countries, null over ocean).

import { test, expect } from '@playwright/test'

test('pickAt returns feature IDs for hover', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/demo.html?id=multi_layer&e2e=1&picking=1#1.5/20/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
  await page.waitForTimeout(2000)

  // Pick at multiple positions. Since countries cover most of the map
  // in this view (zoom 1.5), expect most samples to return featureId > 0.
  // Clients don't know which exact country is where, but "some hits" is
  // enough to validate the pipeline end-to-end.
  const results = await page.evaluate(async () => {
    const m = (window as any).__xgisMap
    const canvas = document.querySelector('#map') as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    const samples: Array<{ x: number; y: number; result: unknown }> = []
    // 5×5 grid of sample points spread across the canvas.
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

  const hits = results.filter(s => s.result !== null)
  const hitRatio = hits.length / results.length
  console.log(`[pick-e2e] hits: ${hits.length}/${results.length} (${(hitRatio * 100).toFixed(0)}%)`)
  for (const h of hits) {
    console.log(`  ${h.x.toFixed(0)},${h.y.toFixed(0)} → ${JSON.stringify(h.result)}`)
  }
  // At world view zoom 1.5, land covers ~30% of the canvas and much
  // of that is ocean between continents. Accept ≥ 5 hits of 25 as
  // "picking pipeline works end-to-end".
  expect(hits.length).toBeGreaterThanOrEqual(5)
  // Hits must all carry a non-zero featureId.
  for (const h of hits) {
    const r = h.result as { featureId: number; instanceId: number }
    expect(r.featureId).toBeGreaterThan(0)
  }
  // Different samples should return different IDs (not all the same country).
  const uniqueIds = new Set(hits.map(h => (h.result as { featureId: number }).featureId))
  expect(uniqueIds.size).toBeGreaterThanOrEqual(2)
})
