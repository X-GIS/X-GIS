// Visual parity probe between MapLibre GL JS and X-GIS, both
// rendering the SAME style.json. Drives the compare.html page that
// mounts both engines side-by-side with synchronised camera. For
// each (style × camera) preset, screenshots each canvas, runs
// pixelmatch, and writes the two source PNGs + diff overlay PNG +
// JSON metrics into `__style-parity-diff__/<fixture>__<name>/`.
//
// Soft gate by design — symbol rendering is not implemented in X-GIS
// yet (Batch 1c on the roadmap), so OFM styles will show a multi-percent
// diff in label-dense scenes. The job here is to *capture* the
// difference, not gate it. Once symbols ship, per-preset thresholds
// can be added next to PRESETS and the soft-log calls flipped to
// expect().
//
// Future toggle (not yet implemented): `?noSymbols=1` query on
// compare.html would strip symbol layers from MapLibre before mount,
// for a labels-removed apples-to-apples comparison. Until then the
// captured metrics include the symbol-layer gap.

import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__style-parity-diff__')
mkdirSync(OUT, { recursive: true })

interface Preset {
  fixture: string  // style id in compare-runner.ts STYLES catalogue
  name: string     // human label for the camera framing
  hash: string     // #z/lat/lon[/bearing/pitch] — applied via URL fragment
}

const PRESETS: Preset[] = [
  { fixture: 'maplibre-demotiles',   name: 'world',     hash: '#1/0/0' },
  { fixture: 'openfreemap-bright',   name: 'world',     hash: '#2/20/0' },
  { fixture: 'openfreemap-bright',   name: 'tokyo',     hash: '#12/35.68/139.76' },
  { fixture: 'openfreemap-bright',   name: 'manhattan', hash: '#14/40.78/-73.97/0/45' },
  { fixture: 'openfreemap-liberty',  name: 'tokyo',     hash: '#12/35.68/139.76' },
  { fixture: 'openfreemap-positron', name: 'world',     hash: '#2/20/0' },
]

interface PresetMetric extends Preset {
  width: number
  height: number
  diffPixels: number
  diffRatio: number
  threshold: number
  durationMs: number
  timestamp: string
}

const metrics: PresetMetric[] = []

for (const preset of PRESETS) {
  test(`parity: ${preset.fixture} — ${preset.name}`, async ({ page }) => {
    test.setTimeout(120_000)

    const t0 = Date.now()
    await page.setViewportSize({ width: 1280, height: 800 })

    const consoleErrors: string[] = []
    page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      const t = m.text()
      if (t.includes('vite/dist/client')) return
      if (t.includes('Failed to load resource')) return
      consoleErrors.push(t)
    })

    await page.goto(`/compare.html?style=${preset.fixture}${preset.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    // Wait for both engines to signal ready.
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean; __mlReady?: boolean })
        .__xgisReady === true
        && (window as unknown as { __mlReady?: boolean }).__mlReady === true,
      null, { timeout: 60_000 },
    )
    // Tiles fetch over the wire — give them a beat to settle on both
    // sides before screenshot.
    await page.waitForTimeout(6_000)

    // Capture both canvases. MapLibre's canvas is injected as the
    // first <canvas> child of the container; X-GIS renders directly
    // into #xg-canv.
    const mlPng = await page.locator('#ml-map canvas').first().screenshot()
    const xgPng = await page.locator('#xg-canv').screenshot()

    const ml = PNG.sync.read(mlPng)
    const xg = PNG.sync.read(xgPng)
    // Normalize to the smaller pair: MapLibre canvas may include a
    // dpr-scaled buffer where X-GIS uses CSS-px. The visual diff is
    // most meaningful at the displayed resolution.
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

    const slug = `${preset.fixture}__${preset.name.replace(/[^a-z0-9]+/gi, '-')}`
    const dir = join(OUT, slug)
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
      timestamp: new Date().toISOString(),
    }
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metric, null, 2))
    metrics.push(metric)

    // eslint-disable-next-line no-console
    console.log(`[parity] ${slug}  ${w}×${h}  ` +
      `diffPixels=${diffPixels}  diffRatio=${(diffRatio * 100).toFixed(2)}%  ` +
      `consoleErrors=${consoleErrors.length}`)
    if (consoleErrors.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[parity] ${slug} errors:\n` + consoleErrors.map(e => '  - ' + e).join('\n'))
    }

    // Soft gate: no expect() on diffRatio. Once symbol rendering
    // lands, per-preset thresholds + expect() flip the gate.
  })
}

test.afterAll(() => {
  if (metrics.length === 0) return
  metrics.sort((a, b) => a.fixture.localeCompare(b.fixture) || a.name.localeCompare(b.name))
  writeFileSync(join(OUT, 'REPORT.json'), JSON.stringify(metrics, null, 2))

  const lines: string[] = []
  lines.push('# Style parity diff report')
  lines.push('')
  lines.push(`Generated ${new Date().toISOString()} by \`_style-parity-diff.spec.ts\`.`)
  lines.push('')
  lines.push('| Fixture | Preset | Size | Diff pixels | Diff ratio |')
  lines.push('|---|---|---:|---:|---:|')
  for (const m of metrics) {
    lines.push(`| ${m.fixture} | ${m.name} | ${m.width}×${m.height} | ${m.diffPixels} | ${(m.diffRatio * 100).toFixed(2)}% |`)
  }
  lines.push('')
  lines.push('Soft-gated — diffs include the expected symbol-layer gap.')
  lines.push('See `<fixture>__<preset>/diff.png` for visualisations.')
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n') + '\n')
})
