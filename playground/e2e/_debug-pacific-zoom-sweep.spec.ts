import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__pacific-zoom-sweep__')
mkdirSync(OUT, { recursive: true })

// User-requested 2026-05-12: at the Pacific reference camera, sweep
// zoom in 1-unit steps to verify the label-duplication regression
// doesn't recur at higher zoom integers. Center stays at the user's
// original 22.8/-165.5 reference; only zoom varies.
const ZOOMS = [1.40, 2.40, 3.40, 4.40, 5.40, 6.40, 7.40, 8.40]

interface Metric {
  zoom: number
  diffPixels: number
  diffRatio: number
  width: number
  height: number
}
const metrics: Metric[] = []

for (const zoom of ZOOMS) {
  test(`pacific-zoom z=${zoom}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1400, height: 800 })
    await page.goto(`/compare.html?style=openfreemap-bright#${zoom}/22.8/-165.5`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean; __mlReady?: boolean })
        .__xgisReady === true
        && (window as unknown as { __mlReady?: boolean }).__mlReady === true,
      null, { timeout: 60_000 },
    )
    await page.waitForTimeout(10_000)
    const panes = page.locator('#panes .pane')
    const mlPng = await panes.nth(0).screenshot()
    const xgPng = await panes.nth(1).screenshot()
    const ml = PNG.sync.read(mlPng)
    const xg = PNG.sync.read(xgPng)
    const w = Math.min(ml.width, xg.width)
    const h = Math.min(ml.height, xg.height)
    const crop = (src: PNG): PNG => {
      const out = new PNG({ width: w, height: h })
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const si = (y * src.width + x) * 4, di = (y * w + x) * 4
          out.data[di] = src.data[si]!
          out.data[di + 1] = src.data[si + 1]!
          out.data[di + 2] = src.data[si + 2]!
          out.data[di + 3] = src.data[si + 3]!
        }
      }
      return out
    }
    const mlNorm = ml.width === w && ml.height === h ? ml : crop(ml)
    const xgNorm = xg.width === w && xg.height === h ? xg : crop(xg)
    const diff = new PNG({ width: w, height: h })
    const diffPixels = pixelmatch(mlNorm.data, xgNorm.data, diff.data, w, h, { threshold: 0.15, includeAA: false })
    const slug = `z${zoom.toFixed(2).replace('.', '_')}`
    const dir = join(OUT, slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'maplibre.png'), PNG.sync.write(mlNorm))
    writeFileSync(join(dir, 'xgis.png'), PNG.sync.write(xgNorm))
    writeFileSync(join(dir, 'diff.png'), PNG.sync.write(diff))
    metrics.push({ zoom, diffPixels, diffRatio: diffPixels / (w * h), width: w, height: h })
    // eslint-disable-next-line no-console
    console.log(`[pacific-zoom] z=${zoom}  diff=${(diffPixels / (w * h) * 100).toFixed(2)}%`)
  })
}

test.afterAll(() => {
  if (metrics.length === 0) return
  metrics.sort((a, b) => a.zoom - b.zoom)
  const lines = ['# Pacific zoom sweep', '', '| Zoom | Diff pixels | Diff ratio |', '|---:|---:|---:|']
  for (const m of metrics) {
    lines.push(`| ${m.zoom} | ${m.diffPixels} | ${(m.diffRatio * 100).toFixed(2)}% |`)
  }
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n') + '\n')
})
