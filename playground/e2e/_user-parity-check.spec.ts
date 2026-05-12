// Pixel-matching parity check at the two camera presets the user
// supplied on 2026-05-12 for OFM Bright review:
//   #1.40/22.8/-165.5          — mid-Pacific, low zoom
//   #17.93/37.12661/126.92401  — Seoul Incheon airport area, high zoom
//
// Captures both panes (MapLibre and X-GIS) at the same camera, runs
// pixelmatch, writes both PNGs + diff overlay + metrics. Mirrors the
// pattern from `_style-parity-diff.spec.ts`.

import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__user-parity__')
mkdirSync(OUT, { recursive: true })

interface Preset {
  name: string
  hash: string
}

const PRESETS: Preset[] = [
  { name: 'pacific-z1.40',  hash: '#1.40/22.8/-165.5' },
  { name: 'seoul-z17.93',   hash: '#17.93/37.12661/126.92401' },
]

interface PresetMetric extends Preset {
  width: number
  height: number
  diffPixels: number
  diffRatio: number
  threshold: number
  durationMs: number
}

const metrics: PresetMetric[] = []

for (const preset of PRESETS) {
  test(`user-parity: ofm-bright ${preset.name}`, async ({ page }) => {
    test.setTimeout(120_000)
    const t0 = Date.now()
    await page.setViewportSize({ width: 1400, height: 800 })

    await page.goto(`/compare.html?style=openfreemap-bright${preset.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean; __mlReady?: boolean })
        .__xgisReady === true
        && (window as unknown as { __mlReady?: boolean }).__mlReady === true,
      null, { timeout: 60_000 },
    )
    // Tile fetch settle. High-zoom Seoul + low-zoom Pacific need
    // different amounts of network time; play it safe.
    await page.waitForTimeout(10_000)

    // Capture pane wrappers (CSS-px DIV) so both engines screenshot
    // at identical dimensions — capturing #ml-map canvas vs #xg-canv
    // gives different pixel buffers due to DPR scaling on the WebGPU
    // side, which made earlier diffs misleading.
    const panes = page.locator('#panes .pane')
    const mlPng = await panes.nth(0).screenshot()
    const xgPng = await panes.nth(1).screenshot()

    const ml = PNG.sync.read(mlPng)
    const xg = PNG.sync.read(xgPng)
    const w = Math.min(ml.width, xg.width)
    const h = Math.min(ml.height, xg.height)
    const cropped = (src: PNG): PNG => {
      const out = new PNG({ width: w, height: h })
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const si = (y * src.width + x) * 4
          const di = (y * w + x) * 4
          out.data[di] = src.data[si]!
          out.data[di + 1] = src.data[si + 1]!
          out.data[di + 2] = src.data[si + 2]!
          out.data[di + 3] = src.data[si + 3]!
        }
      }
      return out
    }
    const mlNorm = ml.width === w && ml.height === h ? ml : cropped(ml)
    const xgNorm = xg.width === w && xg.height === h ? xg : cropped(xg)

    const diff = new PNG({ width: w, height: h })
    const diffPixels = pixelmatch(
      mlNorm.data, xgNorm.data, diff.data, w, h,
      { threshold: 0.15, includeAA: false },
    )
    const diffRatio = diffPixels / (w * h)

    const dir = join(OUT, preset.name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'maplibre.png'), PNG.sync.write(mlNorm))
    writeFileSync(join(dir, 'xgis.png'), PNG.sync.write(xgNorm))
    writeFileSync(join(dir, 'diff.png'), PNG.sync.write(diff))

    const metric: PresetMetric = {
      ...preset,
      width: w, height: h,
      diffPixels, diffRatio,
      threshold: 0.15,
      durationMs: Date.now() - t0,
    }
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metric, null, 2))
    metrics.push(metric)
    // eslint-disable-next-line no-console
    console.log(`[user-parity] ${preset.name}  ${w}×${h}  ` +
      `diffPixels=${diffPixels}  diffRatio=${(diffRatio * 100).toFixed(2)}%`)
  })
}

test.afterAll(() => {
  if (metrics.length === 0) return
  const lines: string[] = ['# User parity check (2026-05-12)', '']
  lines.push('| Preset | Size | Diff pixels | Diff ratio |')
  lines.push('|---|---:|---:|---:|')
  for (const m of metrics) {
    lines.push(`| ${m.name} | ${m.width}×${m.height} | ${m.diffPixels} | ${(m.diffRatio * 100).toFixed(2)}% |`)
  }
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n') + '\n')
})
