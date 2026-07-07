// ═══ Mapbox line-pattern WebGL2 ↔ WebGPU parity tracker (#834 M5 slice 5) ═══
//
// Captures fixture_line_image_pattern (stroke-image-pat over the local
// /fixture-sprite atlas — a 16×16 half-red/half-blue tile) on both backends
// and compares the PATTERN mask (red ∪ blue). This exercises the whole
// WebGL2 image-pattern chain in one shot: the lazy IconStage sprite gate's
// linePattern arm → SpriteAtlasGPU.rhiView/rhiSampler (copyExternalImage
// upload) → _resolveFillPatterns' webgl2 atlas push → VTR's tile bind group
// entries 5/6 → the fs_line_pattern GLSL twin behind the Material's
// per-variant fsCode. A regression to the solid variant (or a stub-white
// sample) drops every red/blue pixel and the mask empties.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const OUT = 'test-results/line-image-pattern-parity'

async function shoot(page: import('@playwright/test').Page, gl2: boolean): Promise<Buffer> {
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto(
    `/demo.html?id=fixture_line_image_pattern&e2e=1&sprite=/fixture-sprite${gl2 ? '&forcegl2=1' : ''}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 35_000 })
  await page.waitForTimeout(9000)
  await page.evaluate(() => (window as any).__xgisMap?.invalidate?.())
  await page.waitForTimeout(1500)
  const canvas = page.locator('canvas').first()
  return canvas.screenshot()
}

test('line image-pattern parity webgl2 vs webgpu', async ({ page, context }) => {
  test.setTimeout(180_000)
  mkdirSync(OUT, { recursive: true })
  const gpuBuf = await shoot(page, false)
  const p2 = await context.newPage()
  const gl2Buf = await shoot(p2, true)
  writeFileSync(`${OUT}/webgpu.png`, gpuBuf)
  writeFileSync(`${OUT}/webgl2.png`, gl2Buf)
  const a = PNG.sync.read(gpuBuf)
  const b = PNG.sync.read(gl2Buf)
  // Per-pixel COLOUR-CLASS agreement over the WebGPU stroke mask. The
  // forcegl2 analytic-checker background is itself red/blue at this zoom, so
  // a plain colour-mask IoU drowns in background false-positives; instead the
  // WebGPU mask is the authority and every one of its pixels must carry the
  // SAME sprite colour class on WebGL2. Regressions all land near 0.5 or
  // below: nothing rendered (checker luck), the solid Stage-1 fallback (one
  // class everywhere), a half-missing tile, or a shifted pattern phase.
  const cls = (im: PNG, p: number): 'red' | 'blue' | null => {
    const i = p * 4
    const r = im.data[i],
      g = im.data[i + 1],
      bl = im.data[i + 2]
    if (Math.abs(r - 220) < 50 && Math.abs(g - 40) < 50 && Math.abs(bl - 40) < 50) return 'red'
    if (Math.abs(r - 40) < 50 && Math.abs(g - 80) < 50 && Math.abs(bl - 220) < 50) return 'blue'
    return null
  }
  let gpuRed = 0,
    gpuBlue = 0,
    agree = 0
  for (let p = 0; p < a.width * a.height; p++) {
    const ca = cls(a, p)
    if (ca === null) continue
    if (ca === 'red') gpuRed++
    else gpuBlue++
    if (cls(b, p) === ca) agree++
  }
  const total = gpuRed + gpuBlue
  const agreement = total > 0 ? agree / total : 0
  console.log(
    `LINE-IMG-PATTERN gpuRed=${gpuRed} gpuBlue=${gpuBlue} agree=${agree} agreement=${agreement.toFixed(3)} dims=${a.width}x${a.height}/${b.width}x${b.height}`,
  )
  expect(gpuRed, 'webgpu stroke shows the red sprite band').toBeGreaterThan(500)
  expect(gpuBlue, 'webgpu stroke shows the blue sprite band').toBeGreaterThan(500)
  expect(agreement, 'per-pixel sprite-colour agreement').toBeGreaterThan(0.85)
})
