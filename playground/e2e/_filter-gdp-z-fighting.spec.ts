// Regression: 2026-05-04 user report at
//   demo.html?id=filter_gdp#4.40/44.04442/99.93433/345.0/46.5
// At pitch=46.5°, the dark slate-900 background fill (from `layer all`)
// shows through colored country fills (wealthy=emerald, top_economies=
// yellow) as broken horizontal/diagonal stripes. Classic z-fighting
// between coplanar fills sharing the same source.
//
// Cause: all polygon fills draw at z=0 (ground plane). Pipeline uses
// depthCompare='less-equal' but no per-layer depth bias; at high pitch
// the log-depth formula compresses precision and coplanar fragments
// fight. Fix: per-layer depth bias subtracted from clip-space z so
// later layers always win ties regardless of depth precision.
//
// Oracle: count "background-color" pixels (slate-900 ≈ rgb(15,23,42))
// inside the colored countries' visible area. Pre-fix sees many such
// pixels (the z-fight stripes); post-fix sees ~0.

import { test, expect, type Page } from '@playwright/test'

async function waitForXgisReady(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
}

test('filter_gdp pitch=46.5: no slate-bg pixels through colored fills', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1920, height: 1040 })
  const consoleLogs: string[] = []
  page.on('console', m => consoleLogs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', e => consoleLogs.push(`[PAGEERR] ${e.message}`))
  await page.goto(
    '/demo.html?id=filter_gdp#4.40/44.04442/99.93433/345.0/46.5',
    { waitUntil: 'domcontentloaded' },
  )
  try { await waitForXgisReady(page) }
  catch (e) {
    console.log('[CONSOLE]')
    for (const l of consoleLogs.slice(0, 20)) console.log('  ' + l)
    throw e
  }
  await page.waitForTimeout(3000)

  await page.screenshot({ path: 'test-results/filter-gdp-pitch.png' })

  // Z-fight stripes inside a colored fill manifest as RAPID brightness
  // OSCILLATION along scanlines (yellow → slate → yellow → slate → ...).
  // A clean fill has uniform brightness across the scanline. Count
  // sign-flipping brightness gradients inside the expected China yellow
  // area as the z-fight signal.
  const stats = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    const png = await new Promise<Blob>(r => canvas.toBlob(b => r(b!), 'image/png'))
    const url = URL.createObjectURL(png)
    const img = new Image()
    await new Promise<void>(r => { img.onload = () => r(); img.src = url })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    URL.revokeObjectURL(url)
    // China-center sampling box (yellow fill in this view)
    const x0 = Math.floor(img.width * 0.30)
    const y0 = Math.floor(img.height * 0.45)
    const x1 = Math.floor(img.width * 0.50)
    const y1 = Math.floor(img.height * 0.78)
    const w = x1 - x0
    const data = ctx.getImageData(x0, y0, w, y1 - y0).data
    // Per scanline: count pixels where the pixel is significantly DARKER
    // than its row-neighbour (z-fight stripe = sudden brightness drop).
    // Bright/dim defined by R+G+B sum.
    let stripeFlips = 0
    let scannedRows = 0
    for (let y = 0; y < y1 - y0; y += 4) {
      let prevSum = -1
      let rowFlips = 0
      let yellowSeen = false
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const sum = data[i] + data[i + 1] + data[i + 2]
        if (sum > 350) yellowSeen = true // yellow ≈ 245+158+11 = 414
        if (prevSum >= 0 && yellowSeen) {
          // sudden drop > 200 = z-fight stripe transition
          if (prevSum - sum > 200) rowFlips++
        }
        prevSum = sum
      }
      if (yellowSeen) {
        stripeFlips += rowFlips
        scannedRows++
      }
    }
    const flipsPerRow = scannedRows > 0 ? stripeFlips / scannedRows : 0
    return { region: [x0, y0, x1, y1], scannedRows, stripeFlips, flipsPerRow }
  })
  console.log(`[filter-gdp-pitch] z-fight stripe flips: ${stats.stripeFlips} across ${stats.scannedRows} rows (${stats.flipsPerRow.toFixed(2)}/row)`)
  // Pre-fix: ~15-25 flips/row (broken). Post-fix: <2/row (only natural
  // country borders crossing the sampling box).
  expect(stats.flipsPerRow, 'z-fight stripe flips per scanline').toBeLessThan(3)
})
