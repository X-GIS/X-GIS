// ═══ Labels WebGL2 ↔ WebGPU parity tracker (#834 M5 slice 3 verification) ═══
//
// Captures the multiline_labels demo on BOTH backends (with the test-pushed
// cities — ?e2e=1 opts out of the demo auto-push) and pixel-diffs them.
// KNOWN by-design divergence: the forced-WebGL2 frame draws the analytic
// checker as its no-raster-source background fixture while the WebGPU frame
// draws the default background, so the RAW DC% is background-dominated. The
// meaningful invariant asserted here is the GLYPH MASK: near-white glyph-core
// pixels must be identical across backends (count, bbox, IoU=1.0 — verified
// 225px / bbox [252,33→370,59] on SwiftShader when this landed).

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const OUT = 'test-results/labels-parity'
const W = 600,
  H = 600

async function shoot(page: import('@playwright/test').Page, gl2: boolean): Promise<Buffer> {
  await page.setViewportSize({ width: W, height: H })
  await page.goto(`/demo.html?id=multiline_labels&e2e=1${gl2 ? '&forcegl2=1' : ''}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as any).__xgisReady === true, null, { timeout: 35_000 })
  await page.evaluate(() => {
    ;(window as any).__xgisMap?.setSourceData?.('cities', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-74, 40.7] },
          properties: { name: 'New York City' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [2.35, 48.85] },
          properties: { name: 'Paris Metropolitan Area' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [139.69, 35.68] },
          properties: { name: 'Tokyo Special Wards' },
        },
      ],
    })
  })
  await page.waitForTimeout(7000)
  await page.evaluate(() => (window as any).__xgisMap?.invalidate?.())
  await page.waitForTimeout(1500)
  const buf = await page.evaluate(
    () =>
      new Promise<number[]>((resolve, reject) => {
        const c = document.querySelector('canvas') as HTMLCanvasElement
        if (!c || typeof c.toBlob !== 'function') return reject(new Error('no canvas'))
        c.toBlob((b) => {
          if (!b) return reject(new Error('toBlob null'))
          b.arrayBuffer().then((ab) => resolve([...new Uint8Array(ab)]))
        }, 'image/png')
      }),
  )
  return Buffer.from(buf)
}

test('labels webgl2 vs webgpu parity', async ({ page, context }) => {
  test.setTimeout(180_000)
  mkdirSync(OUT, { recursive: true })
  const gpuBuf = await shoot(page, false)
  const p2 = await context.newPage()
  const gl2Buf = await shoot(p2, true)
  const gpu = PNG.sync.read(gpuBuf)
  const gl2 = PNG.sync.read(gl2Buf)
  const diff = new PNG({ width: gpu.width, height: gpu.height })
  const n = pixelmatch(gpu.data, gl2.data, diff.data, gpu.width, gpu.height, { threshold: 0.05 })
  let maxD = 0
  for (let i = 0; i < gpu.data.length; i++) {
    const d = Math.abs(gpu.data[i] - gl2.data[i])
    if (d > maxD) maxD = d
  }
  writeFileSync(`${OUT}/webgpu.png`, PNG.sync.write(gpu))
  writeFileSync(`${OUT}/webgl2.png`, PNG.sync.write(gl2))
  writeFileSync(`${OUT}/diff.png`, PNG.sync.write(diff))
  console.log(
    `LABELS-PARITY DC=${((100 * n) / (gpu.width * gpu.height)).toFixed(3)}% maxDelta=${maxD} dims=${gpu.width}x${gpu.height}`,
  )

  // Glyph-mask invariant (background-independent): identical near-white
  // glyph cores on both backends.
  const maskOf = (im: PNG): Set<number> => {
    const m = new Set<number>()
    for (let y = 0; y < im.height; y++)
      for (let x = 0; x < im.width; x++) {
        const i = (y * im.width + x) * 4
        if (im.data[i] > 200 && im.data[i + 1] > 200 && im.data[i + 2] > 200)
          m.add(y * im.width + x)
      }
    return m
  }
  const ma = maskOf(gpu)
  const mb = maskOf(gl2)
  let inter = 0
  for (const p of ma) if (mb.has(p)) inter++
  const iou = inter / (ma.size + mb.size - inter)
  console.log(`LABELS-GLYPH-MASK gpu=${ma.size} gl2=${mb.size} IoU=${iou.toFixed(3)}`)
  expect(ma.size, 'webgpu frame has glyph cores').toBeGreaterThan(100)
  expect(iou, 'glyph cores identical across backends').toBeGreaterThan(0.98)
})
