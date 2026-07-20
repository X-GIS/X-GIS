// ═══ Dashed-line WebGL2 ↔ WebGPU parity tracker (#834 M5 slice 5) ═══
//
// Captures the dashed_lines demo on both backends (canvas-clipped compositor
// screenshots — canvas.toBlob is blank on this demo's WebGPU frame) and
// compares the sky-400 STROKE MASK. The slice-1 renderLinesRhi hardcoded
// dash=null and rendered every dashed stroke SOLID — caught here by the
// tell-tale continuous/dashed pixel ratio ≈ 3/2 on stroke-dasharray-20-10
// (IoU 0.687); after porting render()'s dash derivation the masks agree at
// IoU 0.958, with the residual being 1-2px dash-tip AA specks (rasterizer
// difference, not structure).

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const OUT = 'test-results/dash-parity'

async function shoot(page: import('@playwright/test').Page, gl2: boolean): Promise<Buffer> {
  await page.setViewportSize({ width: 900, height: 700 })
  // Camera PINNED via the location hash: the demo has no camera block, so the
  // boot camera falls out of the two sources' bounds-fit RACE — the two
  // backends (and two runs) can settle on different centres, which shears the
  // dash masks apart (observed IoU 0.958 → 0.098 with identical rendering).
  await page.goto(
    `/demo.html?id=dashed_lines&e2e=1${gl2 ? '&forcegl2=1' : ''}#0.50/0.00000/0.00000`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 35_000 })
  await page.waitForTimeout(9000)
  await page.evaluate(() => (window as any).__xgisMap?.invalidate?.())
  await page.waitForTimeout(1500)
  const canvas = page.locator('canvas').first()
  return canvas.screenshot()
}

test('dash parity webgl2 vs webgpu', async ({ page, context }) => {
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
        // sky-400 ≈ (56,189,248) tol 40
        if (
          Math.abs(im.data[i] - 56) < 40 &&
          Math.abs(im.data[i + 1] - 189) < 40 &&
          Math.abs(im.data[i + 2] - 248) < 40
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
    `DASH-MASK gpu=${ma.size} gl2=${mb.size} inter=${inter} IoU=${iou.toFixed(3)} dims=${a.width}x${a.height}/${b.width}x${b.height}`,
  )
  expect(ma.size, 'webgpu frame has dashed strokes').toBeGreaterThan(3000)
  // Structural agreement: a solid-vs-dashed regression lands at ~0.69.
  expect(iou, 'stroke masks structurally identical').toBeGreaterThan(0.9)
})
