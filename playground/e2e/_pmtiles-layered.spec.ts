// Verifies the per-MVT-layer styling demo. One PMTiles source +
// multiple xgis layers each filtering by `sourceLayer:` paints
// water/landuse/roads/buildings with distinct colors. The render
// should show all four colours simultaneously instead of one
// homogeneous mash.

import { test, expect, type Page } from '@playwright/test'

async function waitForXgisReady(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
}

async function colorCounts(page: Page) {
  const sShot = await page.locator('canvas#map').screenshot({ type: 'png' })
  return await page.evaluate(async ({ pngBytes }) => {
    const blob = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' })
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
    let waterBlue = 0   // sky-900 ≈ rgb(12, 74, 110) — strong blue, low red/green
    let landBeige = 0   // stone-800 ≈ rgb(41, 37, 36) — dark brown
    let roadGrey = 0    // stone-400 ≈ rgb(168, 162, 158) — light grey
    let buildingMid = 0 // stone-700 ≈ rgb(68, 64, 60) — mid brown
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (b > r + 20 && b > g + 10 && b > 60) waterBlue++
      else if (r > 150 && g > 150 && b > 150) roadGrey++
      else if (r > 55 && g > 55 && b > 50 && r < 80) buildingMid++
      else if (r > 30 && g > 30 && b > 30 && r < 55) landBeige++
    }
    URL.revokeObjectURL(url)
    return { waterBlue, landBeige, roadGrey, buildingMid }
  }, { pngBytes: Array.from(sShot) })
}

test('PMTiles layered: Tokyo z=14 paints water, land, roads, buildings distinctly', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 720 })

  await page.goto('/demo.html?id=pmtiles_layered#14/35.68/139.76', { waitUntil: 'domcontentloaded' })
  await waitForXgisReady(page)
  await page.waitForTimeout(8000) // tiles fetch + per-layer slice compile

  await page.locator('canvas#map').screenshot({ path: 'test-results/pmtiles-layered-tokyo.png' })
  const counts = await colorCounts(page)
  console.log(`[layered] water=${counts.waterBlue} land=${counts.landBeige} road=${counts.roadGrey} building=${counts.buildingMid}`)

  // Core assertion: at least three of the four palette buckets land on
  // canvas pixels — proves the per-MVT-layer slices actually separated.
  // Tokyo z=14 covers water (Tokyo Bay) + roads + buildings densely.
  const litPalettes = [counts.waterBlue, counts.landBeige, counts.roadGrey, counts.buildingMid]
    .filter(c => c > 200).length
  expect(litPalettes, 'at least 3 distinct palette colours on canvas').toBeGreaterThanOrEqual(3)
})
