// ═══ Stroke-pattern WebGL2 ↔ WebGPU parity tracker (#834 M5 slice 5) ═══
//
// Captures the fixture_pattern_multi demo on both backends (canvas-clipped
// compositor screenshots — same recipe as _dash-parity) and compares the
// amber-300 STROKE MASK. The demo stacks two procedural pattern slots (dot @
// 18px/24px cadence, cross @ 22px/48px) over a stroke-14 body, so the mask
// carries the pattern extrusions: a slice that drops the pattern slots (the
// pre-port renderLinesRhi passed patterns=[]) renders the bare body and the
// extruded dot/cross pixels vanish from the mask — IoU sinks well below the
// gate. Also locks the multi-TILE span: the fixture line crosses a tile
// boundary mid-screen, so a draw that loses one tile's segments halves the
// mask's x-extent and fails on IoU.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const OUT = 'test-results/pattern-parity'

async function shoot(page: import('@playwright/test').Page, gl2: boolean): Promise<Buffer> {
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto(`/demo.html?id=fixture_pattern_multi&e2e=1${gl2 ? '&forcegl2=1' : ''}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 35_000 })
  await page.waitForTimeout(9000)
  await page.evaluate(() => (window as any).__xgisMap?.invalidate?.())
  await page.waitForTimeout(1500)
  const canvas = page.locator('canvas').first()
  return canvas.screenshot()
}

test('stroke-pattern parity webgl2 vs webgpu', async ({ page, context }) => {
  test.setTimeout(180_000)
  mkdirSync(OUT, { recursive: true })
  const gpuBuf = await shoot(page, false)
  const p2 = await context.newPage()
  const gl2Buf = await shoot(p2, true)
  writeFileSync(`${OUT}/webgpu.png`, gpuBuf)
  writeFileSync(`${OUT}/webgl2.png`, gl2Buf)
  const a = PNG.sync.read(gpuBuf)
  const b = PNG.sync.read(gl2Buf)
  const mask = (im: PNG): Set<number> => {
    const m = new Set<number>()
    for (let y = 0; y < im.height; y++)
      for (let x = 0; x < im.width; x++) {
        const i = (y * im.width + x) * 4
        // amber-300 ≈ (252,211,77) tol 40
        if (
          Math.abs(im.data[i] - 252) < 40 &&
          Math.abs(im.data[i + 1] - 211) < 40 &&
          Math.abs(im.data[i + 2] - 77) < 40
        )
          m.add(y * im.width + x)
      }
    return m
  }
  const ma = mask(a),
    mb = mask(b)
  let inter = 0
  for (const p of ma) if (mb.has(p)) inter++
  const iou = inter / (ma.size + mb.size - inter)
  console.log(
    `PATTERN-MASK gpu=${ma.size} gl2=${mb.size} inter=${inter} IoU=${iou.toFixed(3)} dims=${a.width}x${a.height}/${b.width}x${b.height}`,
  )
  expect(ma.size, 'webgpu frame has patterned stroke').toBeGreaterThan(3000)
  // Structural agreement: pattern extrusions + both tiles present. Residual
  // is edge AA on the dot/cross silhouettes (rasterizer difference).
  expect(iou, 'stroke masks structurally identical').toBeGreaterThan(0.9)
})
