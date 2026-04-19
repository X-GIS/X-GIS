// Runtime quality toggle — verify map.setQuality() flips MSAA,
// picking, and DPR at runtime without validation errors, and that
// pickAt() keeps working after turning picking on and off.

import { test, expect } from '@playwright/test'

test('runtime quality toggles apply without validation errors', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1200, height: 800 })

  const consoleErrors: string[] = []
  page.on('console', m => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })

  // Load with picking=1 so we start in the "heavy" mode — every renderer
  // has a 2-target pipeline and the opaque pass has 2 color attachments.
  await page.goto('/demo.html?id=multi_layer&e2e=1&picking=1#1.5/20/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
  await page.waitForTimeout(1500)

  // Helper: 5×5 grid pickAt sweep. Returns count of non-null hits.
  const pickSweep = async () => await page.evaluate(async () => {
    const m = (window as any).__xgisMap
    const canvas = document.querySelector('#map') as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    let hits = 0
    for (let iy = 1; iy <= 5; iy++) {
      for (let ix = 1; ix <= 5; ix++) {
        const x = rect.left + (rect.width * ix) / 6
        const y = rect.top + (rect.height * iy) / 6
        if (await m.pickAt(x, y)) hits++
      }
    }
    return hits
  })

  // 1) baseline — pickAt works with boot-time picking=1
  const hitsBoot = await pickSweep()
  console.log(`[runtime-quality] boot hits: ${hitsBoot}/25`)
  expect(hitsBoot).toBeGreaterThan(0)

  // 2) toggle picking OFF → pickAt returns null everywhere
  await page.evaluate(() => (window as any).__xgisMap.setQuality({ picking: false }))
  await page.waitForTimeout(800)
  const hitsOff = await pickSweep()
  console.log(`[runtime-quality] picking-off hits: ${hitsOff}/25`)
  expect(hitsOff).toBe(0) // pickTexture gone, pickAt returns null

  // 3) toggle picking back ON → pickAt works again
  await page.evaluate(() => (window as any).__xgisMap.setQuality({ picking: true }))
  await page.waitForTimeout(1200)
  const hitsOn = await pickSweep()
  console.log(`[runtime-quality] picking-on hits: ${hitsOn}/25`)
  expect(hitsOn).toBeGreaterThan(0)

  // 4) toggle MSAA 1 → 4 (disables picking too — setQuality clears in
  //    order, so we pass msaa alongside picking:false).
  await page.evaluate(() => (window as any).__xgisMap.setQuality({ msaa: 4, picking: false }))
  await page.waitForTimeout(1200)
  const q4 = await page.evaluate(() => (window as any).__xgisMap.getQuality())
  expect(q4.msaa).toBe(4)
  expect(q4.picking).toBe(false)

  // 5) toggle MSAA 4 → 1 (WebGPU only supports 1 or 4 — msaa=2 is silently
  //    downgraded to 1 by clampMsaa)
  await page.evaluate(() => (window as any).__xgisMap.setQuality({ msaa: 1 }))
  await page.waitForTimeout(1200)
  const q5 = await page.evaluate(() => (window as any).__xgisMap.getQuality())
  expect(q5.msaa).toBe(1)

  // 6) toggle DPR cap (cheap path — just next resize)
  await page.evaluate(() => (window as any).__xgisMap.setQuality({ maxDpr: 1 }))
  await page.waitForTimeout(500)
  const q6 = await page.evaluate(() => (window as any).__xgisMap.getQuality())
  expect(q6.maxDpr).toBe(1)

  // No WebGPU / X-GIS validation errors through any of the transitions.
  const validation = consoleErrors.filter(m =>
    m.includes('[WebGPU validation]') ||
    m.includes('frame-validation') ||
    m.includes('[X-GIS pass:'),
  )
  if (validation.length > 0) {
    console.log('[runtime-quality] validation errors:')
    for (const e of validation.slice(0, 5)) console.log(`  ${e}`)
  }
  expect(validation).toEqual([])
})
