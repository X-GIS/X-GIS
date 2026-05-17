// Hypothesis-test: does calling setQuality({picking:true}) AFTER a
// demo has rendered successfully break subsequent frames? If yes the
// bug is in setQuality / rebuildForQuality. If no the bug is in the
// boot-time ordering when setQuality happens during init (as happens
// for any demo with `picking: true` in DEMOS).

import { test, expect } from '@playwright/test'

async function countNonBg(page: import('@playwright/test').Page): Promise<number> {
  const png = await page.locator('#map').screenshot({ type: 'png' })
  return await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('img')); img.src = url })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, img.width, img.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > 30 || d[i + 1] > 30 || d[i + 2] > 40) n++
    URL.revokeObjectURL(url)
    return n
  }, Array.from(png))
}

test('setQuality({picking:true}) on multi_layer mid-flight', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1024, height: 720 })
  await page.goto('/demo.html?id=multi_layer', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true, null, { timeout: 15_000 })
  await page.waitForTimeout(2500)

  const before = await countNonBg(page)
  console.log(`before setQuality: ${before} non-bg px`)

  // Programmatic setQuality call mid-flight — same path the picking demo
  // hits at boot when `picking: true` is in DEMOS.
  await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: { setQuality(q: { picking: boolean }): void } }).__xgisMap
    m?.setQuality({ picking: true })
  })
  await page.waitForTimeout(2500)

  const after = await countNonBg(page)
  console.log(`after setQuality:  ${after} non-bg px`)

  // After should be roughly equal (not zero!). Any drop > 50% means
  // setQuality broke the render path.
  expect(after, `setQuality broke rendering: ${before} → ${after}`).toBeGreaterThan(before * 0.5)
})
