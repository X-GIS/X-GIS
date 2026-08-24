// ═══ #1496 — oblique_mercator seam-streak gate ═══
//
// The rotated projection's branch cut (the oblique antimeridian) tracks the
// camera and does not follow tile seams, so a tile can carry a STROKE segment
// whose endpoints project a world circumference apart — drawn, it is a bright
// full-frame streak (the report's "선이 화면을 가로지른다"). The line VS now
// degenerates any segment whose two projected endpoints sit more than half a
// world apart in projected X (line.ts finalize block, #1496).
//
// Structural assertion per the issue's own verification clause — NOT a pixel
// count (§12): at the repro camera no real stroke geometry runs straight
// across the frame, so the longest horizontal run of BRIGHT (stroke-class)
// pixels must stay far below the frame width. Pre-fix the streaks ran
// edge-to-edge (run ≈ full width); post-fix the longest legitimate stroke run
// is a coastline stretch well under 40%. Bright-only thresholding keeps the
// gate honest about the remaining KNOWN residue — seam-crossing FILL
// triangles still leave ~1px dark slivers (fill-color, far below the bright
// threshold); that follow-up stays open on #1496.

import { test, expect } from '@playwright/test'

test('#1496 — no full-frame stroke streaks on oblique_mercator at the repro camera', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1024, height: 720 })

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

  await page.goto('/demo.html?id=dark&proj=oblique_mercator#1.5/20/140', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(4000)

  const png = await page.locator('#map').screenshot({ type: 'png' })
  const m = await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('img'))
      img.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const w = img.width,
      h = img.height
    const d = ctx.getImageData(0, 0, w, h).data
    // Bright stroke-class pixels (the dark demo's cyan borders); the page
    // background and the fill are far darker. Runs tolerate 1px gaps so AA
    // dips inside a genuine streak cannot split it under the threshold.
    const bright = (x: number, y: number): boolean => {
      const i = (y * w + x) * 4
      return 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]! > 90
    }
    let maxRun = 0
    let paint = 0
    for (let y = 40; y < h - 40; y++) {
      let run = 0
      let gap = 0
      for (let x = 0; x < w; x++) {
        if (bright(x, y)) {
          run += 1 + gap
          gap = 0
          paint++
          if (run > maxRun) maxRun = run
        } else if (run > 0 && gap === 0) {
          gap = 1
        } else {
          run = 0
          gap = 0
        }
      }
    }
    URL.revokeObjectURL(url)
    return { maxRun, width: w, paint }
  }, Array.from(png))

  expect(errors, `pageerrors: ${errors.join(' | ')}`).toHaveLength(0)
  // The scene must actually have stroke content (vacuity guard).
  expect(m.paint, 'stroke pixels must be present').toBeGreaterThan(5000)
  // No bright run anywhere near frame-crossing. Pre-fix streaks ran
  // edge-to-edge (maxRun ≈ width); legitimate coastlines stay short.
  expect(
    m.maxRun,
    `longest horizontal bright run ${m.maxRun}px of ${m.width}px — a seam streak crosses the frame`,
  ).toBeLessThan(Math.floor(m.width * 0.4))
})
