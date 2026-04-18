// pointer-events: 'none' takes a layer out of pickAt without affecting
// its visual output. Toggle back to 'auto' restores pickability.
//
// multi_layer scene: `fill` layer (orange country fill, drawn from the
// `world` source) is the topmost interactive surface. Setting
// `getLayer('fill').style.pointerEvents = 'none'` switches its
// pipeline to writeMask:0 on the pick attachment, so pickAt over a
// country yields null (or hits a different layer underneath, but
// never the `fill` layer's id).

import { test, expect } from '@playwright/test'

test('pointer-events:none takes a layer out of pickAt', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/demo.html?id=multi_layer&e2e=1&picking=1#1.5/20/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
  await page.waitForTimeout(1500)

  const fillId = await page.evaluate(() => {
    const m = (window as { __xgisMap?: { getLayer(n: string): { id: number } | null } }).__xgisMap!
    return m.getLayer('fill')?.id ?? 0
  })
  expect(fillId).toBeGreaterThan(0)

  const sweep = async () => await page.evaluate(async () => {
    const m = (window as { __xgisMap?: { pickAt(x: number, y: number): Promise<unknown> } }).__xgisMap!
    const canvas = document.querySelector('#map') as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    const hits: Array<{ layerId: number; featureId: number }> = []
    for (let iy = 1; iy <= 5; iy++) {
      for (let ix = 1; ix <= 5; ix++) {
        const x = rect.left + (rect.width * ix) / 6
        const y = rect.top + (rect.height * iy) / 6
        const r = await m.pickAt(x, y) as { featureId: number; layerId: number } | null
        if (r) hits.push(r)
      }
    }
    return hits
  })

  // Baseline: fill layer is pickable.
  const before = await sweep()
  console.log(`[pointer-events] fillId=${fillId} before=${before.length}`)
  expect(before.length).toBeGreaterThan(0)
  expect(before.some(h => h.layerId === fillId)).toBe(true)

  // Toggle pointer-events: none on the fill layer.
  await page.evaluate(() => {
    const m = (window as { __xgisMap?: { getLayer(n: string): { style: { pointerEvents: string } } | null } }).__xgisMap!
    m.getLayer('fill')!.style.pointerEvents = 'none'
  })
  await page.waitForTimeout(500)
  const off = await sweep()
  console.log(`[pointer-events] off=${off.length}, fill hits=${off.filter(h => h.layerId === fillId).length}`)
  // Fill layer's pickId no longer lands in the pick texture.
  expect(off.some(h => h.layerId === fillId)).toBe(false)

  // Toggle back to 'auto' → fill becomes pickable again.
  await page.evaluate(() => {
    const m = (window as { __xgisMap?: { getLayer(n: string): { style: { pointerEvents: string } } | null } }).__xgisMap!
    m.getLayer('fill')!.style.pointerEvents = 'auto'
  })
  await page.waitForTimeout(500)
  const restored = await sweep()
  console.log(`[pointer-events] restored=${restored.length}, fill hits=${restored.filter(h => h.layerId === fillId).length}`)
  expect(restored.some(h => h.layerId === fillId)).toBe(true)
})
