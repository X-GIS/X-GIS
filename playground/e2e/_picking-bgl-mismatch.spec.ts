// Regression: enabling picking via setQuality() nullified per-show
// variant pipelines but left their `entry.layout` pointing at the
// previous feature/compute layout. The bucket-scheduler then served
// `defaults.fillPipeline` (base-only) with `entry.layout` (feature),
// tripping WebGPU validation every frame and the data-driven match()
// polygons never painted (see _fixture-picking.spec.ts: only 2 of 3
// quadrants were ever pickable).
//
// This spec is the minimal repro: load fixture_picking WITHOUT the
// `?picking=1` URL flag, so picking is OFF at module load. The demo's
// `picking: true` flag then triggers demo-runner's
// setQuality({picking:true}) AFTER layers are wired — which is the
// path that hits the rebuild-but-don't-re-resolve bug. With
// `?picking=1` in the URL, picking is already on at resolveQuality()
// time and the rebuild path is never taken — the bug doesn't repro.

import { test, expect, type Page } from '@playwright/test'

async function loadAndCollect(page: Page, id: string, picking: boolean): Promise<{
  errors: string[]
  paintedPx: number
}> {
  const errors: string[] = []
  const onConsole = (m: import('@playwright/test').ConsoleMessage): void => {
    if (m.type() === 'error') errors.push(m.text())
  }
  const onPageError = (e: Error): void => { errors.push(`pageerror: ${e.message}`) }
  page.on('console', onConsole)
  page.on('pageerror', onPageError)

  const url = picking
    ? `/demo.html?id=${id}&e2e=1`
    : `/demo.html?id=${id}&e2e=1`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
  // Hold long enough for ~1 s of frames so per-frame validation
  // errors (the bug fired on every draw) have plenty of chances.
  await page.waitForTimeout(2000)

  const paintedPx = await page.evaluate(() => {
    // Count quadrant-coloured pixels — fixture_picking uses red-500,
    // emerald-500, blue-500. Anything saturated counts.
    const canvas = document.querySelector('#map canvas') as HTMLCanvasElement
    if (!canvas) return 0
    // Read via Playwright screenshot below; here just confirm canvas
    // exists. Real pixel count comes from Playwright screenshot.
    return canvas.width * canvas.height
  })

  page.off('console', onConsole)
  page.off('pageerror', onPageError)
  return { errors, paintedPx }
}

test('fixture_picking: no frame-validation when picking enabled (regression)', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 800 })
  const { errors } = await loadAndCollect(page, 'fixture_picking', true)
  const validation = errors.filter(e => /frame-validation|Bind group layout|does not match layout/i.test(e))
  expect(validation, `Got validation errors: ${validation.join('\n')}`).toHaveLength(0)
})

test('fixture_picking: paints all 3 quadrant colours (regression)', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/demo.html?id=fixture_picking&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
  await page.waitForTimeout(2000)

  // Screenshot the map area and count pixels that match each quadrant
  // colour family. red-500 ≈ (239,68,68), emerald-500 ≈ (16,185,129),
  // blue-500 ≈ (59,130,246). Use loose channel tolerances since
  // WebGPU's MSAA + tonemap shifts exact values slightly per GPU.
  const png = await page.locator('#map').screenshot({ type: 'png' })
  const counts = await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res(); img.onerror = () => rej(new Error('img'))
      img.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height).data
    let red = 0, green = 0, blue = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2]
      // Loose "dominant channel" classifier — picks the quadrant a
      // pixel belongs to even when MSAA blends down the saturation.
      if (r > 150 && g < 100 && b < 100) red++
      else if (g > 130 && r < 100 && b < 160) green++
      else if (b > 180 && r < 130 && g < 170) blue++
    }
    URL.revokeObjectURL(url)
    return { red, green, blue }
  }, Array.from(png))

  // Each quadrant must contribute a meaningful number of pixels. The
  // pre-fix scenario painted only 2 quadrants (one was the buggy one
  // that hit validation and got dropped).
  expect(counts.red,   `red quadrant missing: ${JSON.stringify(counts)}`).toBeGreaterThan(500)
  expect(counts.green, `green quadrant missing: ${JSON.stringify(counts)}`).toBeGreaterThan(500)
  expect(counts.blue,  `blue quadrant missing: ${JSON.stringify(counts)}`).toBeGreaterThan(500)
})
