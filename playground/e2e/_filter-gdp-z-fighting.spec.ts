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
    null,
    { timeout: 15_000 },
  )
}

test('filter_gdp pitch=46.5: no slate-bg pixels through colored fills', async ({ page }) => {
  // 45_000 -> 90_000. The 45 s cap was 6% of headroom, not a budget: MEASURED at
  // 42.3 s on a green CI run (X-GIS/X-GIS run 33707088226, render-shard 2/6) and
  // 34.1 s locally on headless SwiftShader. A slower runner then times this out in
  // `canvas.toBlob` -- AFTER `__xgisReady` has already flipped, so the scene had
  // rendered and only the readback ran out of clock. Nothing here is skipped or
  // relaxed: every assertion still runs, on the same frame, against the same
  // thresholds. The cost is dominated by a cold filter_gdp boot (the ~1.7 s
  // driver-compile hitch `prewarmShaderVariantsAsync` documents is this scene),
  // a 3 s settle and a full-page 1920x1040 screenshot, none of which a cap this
  // tight can absorb.
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1920, height: 1040 })
  const consoleLogs: string[] = []
  page.on('console', (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => consoleLogs.push(`[PAGEERR] ${e.message}`))
  await page.goto('/demo.html?id=filter_gdp#4.40/44.04442/99.93433/345.0/46.5', {
    waitUntil: 'domcontentloaded',
  })
  try {
    await waitForXgisReady(page)
  } catch (e) {
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
    const png = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'))
    const url = URL.createObjectURL(png)
    const img = new Image()
    await new Promise<void>((r) => {
      img.onload = () => r()
      img.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    URL.revokeObjectURL(url)
    // China-center sampling box (yellow fill in this view)
    const x0 = Math.floor(img.width * 0.3)
    const y0 = Math.floor(img.height * 0.45)
    const x1 = Math.floor(img.width * 0.5)
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
  console.log(
    `[filter-gdp-pitch] z-fight stripe flips: ${stats.stripeFlips} across ${stats.scannedRows} rows (${stats.flipsPerRow.toFixed(2)}/row)`,
  )
  // #2399 D2 — pin the DENOMINATOR before trusting the ratio. `flipsPerRow`
  // falls back to 0 when `scannedRows` is 0 (see the ternary above), so a frame
  // carrying no yellow at all scores 0 and passes the `< 3` bar below: a blank
  // canvas is indistinguishable from a perfectly clean fill, which is the one
  // state this gate exists to catch.
  //
  // Not hypothetical, and the sample is not stable. MEASURED on this spec's own
  // 1920x1040 view: 86 rows on runs that pass (three attempts on run
  // 33718783375, plus a local SwiftShader control) and 37 rows on a loaded
  // runner (two attempts on run 33720643413) — a sample less than half the size,
  // scoring 0.59/row against the same 3.0 bar, silently accepted. The settle
  // above is 3 s of WALL CLOCK while the scene converges on frames and uploads,
  // so a slower machine simply lands fewer tiles inside it; the fixture's
  // pending-work registry needs ~41 s after `__xgisReady` to go clear (#2370).
  //
  // The floor is therefore set to admit the degraded-but-real 37-row sample and
  // reject the vacuous one — anything else would turn a slow runner into a red
  // gate, trading one silent failure for a loud false one. Replacing the sleep
  // with a converged settle is the real fix and is NOT free: it costs ~+38 s,
  // which overruns the 90 s cap (#2399, #2460).
  expect(
    stats.scannedRows,
    'the yellow sample must EXIST before its flip ratio means anything (#2399)',
  ).toBeGreaterThan(15)
  // Pre-fix: ~15-25 flips/row (broken). Post-fix: <2/row (only natural
  // country borders crossing the sampling box).
  expect(stats.flipsPerRow, 'z-fight stripe flips per scanline').toBeLessThan(3)
})
