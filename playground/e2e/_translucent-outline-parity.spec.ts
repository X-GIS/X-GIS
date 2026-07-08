// ═══ Translucent-outline WebGL2 ↔ WebGPU parity tracker (#834 M5 slice 6) ═══
//
// Captures fixture_translucent_outline on both backends and compares the
// BLENDED stroke band: an inset amber-300 stroke at layer opacity 0.6 over an
// opaque slate-800 base ≈ rgb(166,143,70) — background-independent by fixture
// construction, so a plain colour mask works on the checker-background
// forced-WebGL2 frame. This exercises the whole WebGL2 translucent chain in
// one shot: bucket classification (fill+stroke+opacity<1 → translucent;
// fillPhase 'fills' suppresses the opaque-pass stroke), the RHI offscreen
// pass (beginOffscreenPass FBO), the fs_line_max GLSL twin behind the MAX
// material, and the fullscreen compositor twin at resolved opacity.
// Regressions land far outside the mask: nothing rendered → slate-800; the
// old opaque double-draw → full amber (252,211,77), Δred ≈ 86 ≫ tol.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const OUT = 'test-results/translucent-outline-parity'

async function shoot(page: import('@playwright/test').Page, gl2: boolean): Promise<Buffer> {
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto(
    `/demo.html?id=fixture_translucent_outline&e2e=1${gl2 ? '&forcegl2=1' : ''}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 35_000 })
  await page.waitForTimeout(9000)
  await page.evaluate(() => (window as any).__xgisMap?.invalidate?.())
  await page.waitForTimeout(1500)
  const canvas = page.locator('canvas').first()
  return canvas.screenshot()
}

test('translucent outline parity webgl2 vs webgpu', async ({ page, context }) => {
  test.setTimeout(180_000)
  mkdirSync(OUT, { recursive: true })
  const gpuBuf = await shoot(page, false)
  const p2 = await context.newPage()
  const gl2Buf = await shoot(p2, true)
  writeFileSync(`${OUT}/webgpu.png`, gpuBuf)
  writeFileSync(`${OUT}/webgl2.png`, gl2Buf)
  const a = PNG.sync.read(gpuBuf)
  const b = PNG.sync.read(gl2Buf)
  // 0.6·amber-300 + 0.4·slate-800 ≈ (166,143,70), tol 35 — excludes both the
  // full-amber opaque regression (252,211,77) and the bare slate-800 fill.
  const blended = (im: PNG, p: number): boolean => {
    const i = p * 4
    return (
      Math.abs(im.data[i] - 166) < 35 &&
      Math.abs(im.data[i + 1] - 143) < 35 &&
      Math.abs(im.data[i + 2] - 70) < 35
    )
  }
  let gpuN = 0,
    inter = 0,
    gl2N = 0
  for (let p = 0; p < a.width * a.height; p++) {
    const ia = blended(a, p)
    const ib = blended(b, p)
    if (ia) gpuN++
    if (ib) gl2N++
    if (ia && ib) inter++
  }
  const iou = inter / (gpuN + gl2N - inter)
  console.log(
    `TRANSLUCENT-OUTLINE gpu=${gpuN} gl2=${gl2N} inter=${inter} IoU=${iou.toFixed(3)} dims=${a.width}x${a.height}/${b.width}x${b.height}`,
  )
  expect(gpuN, 'webgpu frame shows the blended translucent stroke').toBeGreaterThan(2000)
  expect(iou, 'blended-stroke masks structurally identical').toBeGreaterThan(0.9)
})
