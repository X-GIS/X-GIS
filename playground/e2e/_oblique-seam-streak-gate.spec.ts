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
// is a coastline stretch well under 40%.
//
// The FILL half of #1496 is the second assertion at the bottom of this test.
// The same cut also straddles fill triangles, which rasterise as 1–2 px
// fill-coloured NEEDLES across the frame — invisible to the bright-only run
// scan above (they are fill-colour, far under its threshold), so they need
// their own thinness-qualified scan on a chrome-free capture. A fill vertex
// cannot be degenerated the way a line segment can (it sees only itself), so
// the discard is fragment-side: polygon-seam-needle.ts.

import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'
import { captureMapFrame } from './helpers/visual'

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
  // Content-driven settle instead of a fixed sleep: a loaded SwiftShader
  // container can take >4s to first-paint the countries layer, and a frame
  // captured before it lands trips the vacuity guard below (observed
  // 2026-08-24: 19 bright px, no pageerrors). Poll until stroke content is
  // present (or 30s — then the vacuity guard fails as before), settle once,
  // and assert on the final frame. Streaks cannot dodge this: they ARE
  // stroke geometry, drawn with the very content the poll waits for (the
  // pre-fix RED run streaked on the first content-bearing frame).
  const measure = async (): Promise<{ maxRun: number; width: number; paint: number }> => {
    const png = await page.locator('#map').screenshot({ type: 'png' })
    return measureFrame(png)
  }
  const measureFrame = (png: Buffer): Promise<{ maxRun: number; width: number; paint: number }> =>
    page.evaluate(async (bytes) => {
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

  const deadline = Date.now() + 30_000
  let m = await measure()
  while (m.paint <= 5000 && Date.now() < deadline) {
    await page.waitForTimeout(1000)
    m = await measure()
  }
  await page.waitForTimeout(1500)
  m = await measure()

  expect(errors, `pageerrors: ${errors.join(' | ')}`).toHaveLength(0)
  // The scene must actually have stroke content (vacuity guard).
  expect(m.paint, 'stroke pixels must be present').toBeGreaterThan(5000)
  // No bright run anywhere near frame-crossing. Pre-fix streaks ran
  // edge-to-edge (maxRun ≈ width); legitimate coastlines stay short.
  expect(
    m.maxRun,
    `longest horizontal bright run ${m.maxRun}px of ${m.width}px — a seam streak crosses the frame`,
  ).toBeLessThan(Math.floor(m.width * 0.4))

  // #1496 (fill residue) — no NEEDLE rows: a seam-straddling fill triangle
  // rasterises as a 1–2 px fill-coloured run across the frame. Chrome-free
  // capture (capture-canvas), then scan for long fill-class runs whose rows
  // ±2 px are not fill. Pre-fix: 11 such rows at this camera; post-fix: none.
  const frame = await captureMapFrame(page)
  const { width: fw, height: fh, data } = PNG.sync.read(frame)
  const key = (p: number) => (data[p * 4] << 16) | (data[p * 4 + 1] << 8) | data[p * 4 + 2]
  const hist = new Map<number, number>()
  for (let p = 0; p < fw * fh; p++) hist.set(key(p), (hist.get(key(p)) ?? 0) + 1)
  const bg = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]![0]
  const lum = (p: number) => 0.299 * data[p * 4] + 0.587 * data[p * 4 + 1] + 0.114 * data[p * 4 + 2]
  const isFill = (p: number) => key(p) !== bg && lum(p) <= 90
  const needles: string[] = []
  for (let y = 2; y < fh - 2; y++) {
    let x = 0
    while (x < fw) {
      if (!isFill(y * fw + x)) {
        x++
        continue
      }
      let x1 = x
      while (x1 < fw && isFill(y * fw + x1)) x1++
      const len = x1 - x
      if (len >= 120) {
        let thin = 0
        for (let xx = x; xx < x1; xx++)
          if (!isFill((y - 2) * fw + xx) && !isFill((y + 2) * fw + xx)) thin++
        if (thin / len >= 0.8) needles.push(`y=${y} x=${x}..${x1} (${len} px)`)
      }
      x = x1
    }
  }
  expect(needles, `seam-straddling fill needles:\n${needles.join('\n')}`).toEqual([])
})
