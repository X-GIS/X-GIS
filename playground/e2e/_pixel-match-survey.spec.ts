// ═══════════════════════════════════════════════════════════════════
// Pixel-match survey — multi-fixture, multi-view X-GIS vs MapLibre
// ═══════════════════════════════════════════════════════════════════
//
// Sweeps the compare runner across 4 representative views to measure
// X-GIS visual parity against MapLibre — the canonical reference. Each
// view runs labels + icons OFF on both sides so the comparison
// isolates fill / line / outline rendering.
//
// Output: one consolidated REPORT.md with a single table summarizing
//   - Identical pixel % (max-channel-delta == 0)
//   - Within-32 RGB delta %  (visually equivalent class)
//   - Within-128 RGB delta %  (small drift)
//   - Worst-case pixel % (>128)
//
// Per-view delta-PNGs go under __pixel-match-survey__/<view>/.

import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__pixel-match-survey__')
mkdirSync(OUT, { recursive: true })

interface ViewSpec {
  id: string
  style: string
  /** `#zoom/lat/lon` */
  hash: string
  description: string
}

const VIEWS: ViewSpec[] = [
  // The plan's P1 verification gate — school fill area in Seoul.
  { id: 'bright-seoul-school',
    style: 'openfreemap-bright',
    hash: '#17.85/37.12665/126.92430',
    description: 'OFM Bright, Seoul 행정초등학교 — P1 verification gate (school fill)' },

  // OFM Bright at a lower zoom — different fill mix (water + landuse).
  { id: 'bright-tokyo-z14',
    style: 'openfreemap-bright',
    hash: '#14/35.6585/139.7454',
    description: 'OFM Bright, Tokyo z=14 — landuse + water fills' },

  // OFM Liberty — uses different color palette + interpolate stops.
  { id: 'liberty-paris-z14',
    style: 'openfreemap-liberty',
    hash: '#14/48.8534/2.3488',
    description: 'OFM Liberty, Paris z=14 — interpolate-zoom heavy' },

  // Demotiles — country fills via 214-arm match() (P5 LUT target
  // when compute path runs MVT, currently still legacy if-else for VTR).
  { id: 'demotiles-europe-z2',
    style: 'maplibre-demotiles',
    hash: '#2.5/48/15',
    description: 'MapLibre demotiles, Europe z=2 — 214-arm ADM0_A3 country palette' },
]

interface Buckets {
  eq0: number; le8: number; le16: number; le32: number
  le64: number; le128: number; gt128: number
}

async function hideSymbolLayers(page: import('@playwright/test').Page) {
  // MapLibre: hide every symbol layer.
  await page.evaluate(() => {
    interface MlMap {
      getStyle(): { layers: Array<{ id: string; type: string }> }
      setLayoutProperty(id: string, key: string, value: 'none' | 'visible'): void
    }
    const ml = (window as unknown as { __mlMap?: MlMap }).__mlMap
    if (!ml) return
    for (const layer of ml.getStyle().layers) {
      if (layer.type === 'symbol') {
        ml.setLayoutProperty(layer.id, 'visibility', 'none')
      }
    }
  })

  // X-GIS: hide label-bearing + symbol-shaped layers via the public API.
  await page.evaluate(() => {
    interface XGISShow { label?: unknown; visible?: boolean }
    interface XGISLayer { name?: string; style?: { visible?: boolean } }
    interface XGISMap {
      vectorTileShows?: Array<{ show: XGISShow }>
      getLayers?(): readonly XGISLayer[]
      invalidate?(): void
    }
    const map = (window as unknown as { __xgisMap?: XGISMap }).__xgisMap
    if (!map) return
    for (const e of map.vectorTileShows ?? []) {
      if (e.show.label !== undefined) e.show.visible = false
    }
    for (const layer of map.getLayers?.() ?? []) {
      if (!layer.style) continue
      const name = (layer.name ?? '').toLowerCase()
      if (/label|icon|poi|name|symbol|aerodrome|housenumber/.test(name)) {
        layer.style.visible = false
      }
    }
    map.invalidate?.()
  })

  // Wait for both sides to settle.
  await page.evaluate(() => new Promise<void>((resolve) => {
    interface MlMap { loaded(): boolean; once(ev: string, fn: () => void): void }
    const ml = (window as unknown as { __mlMap?: MlMap }).__mlMap
    if (!ml) { resolve(); return }
    if (ml.loaded()) { resolve(); return }
    ml.once('idle', () => resolve())
    setTimeout(resolve, 12_000)
  }))
  await page.waitForTimeout(3_500)
  await page.evaluate(() => new Promise<void>(r =>
    requestAnimationFrame(() => requestAnimationFrame(() => r()))))
}

function diffBuckets(a: PNG, b: PNG, w: number, h: number): Buckets {
  const buckets: Buckets = { eq0: 0, le8: 0, le16: 0, le32: 0, le64: 0, le128: 0, gt128: 0 }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const dr = Math.abs(a.data[i]! - b.data[i]!)
      const dg = Math.abs(a.data[i + 1]! - b.data[i + 1]!)
      const db = Math.abs(a.data[i + 2]! - b.data[i + 2]!)
      const m = Math.max(dr, dg, db)
      if (m === 0) buckets.eq0++
      else if (m <= 8) buckets.le8++
      else if (m <= 16) buckets.le16++
      else if (m <= 32) buckets.le32++
      else if (m <= 64) buckets.le64++
      else if (m <= 128) buckets.le128++
      else buckets.gt128++
    }
  }
  return buckets
}

function cropPng(src: PNG, w: number, h: number): PNG {
  if (src.width === w && src.height === h) return src
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

interface ViewResult {
  id: string
  style: string
  hash: string
  canvasW: number
  canvasH: number
  totalPx: number
  buckets: Buckets
}

const results: ViewResult[] = []

for (const view of VIEWS) {
  test(`pixel-match ${view.id}`, async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/compare.html?style=${view.style}${view.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
        return w.__xgisReady === true && w.__mlReady === true
      },
      null, { timeout: 90_000 },
    )
    await hideSymbolLayers(page)

    const mlPng = await page.locator('#ml-map canvas').first().screenshot()
    const xgPng = await page.locator('#xg-canv').screenshot()
    const ml = PNG.sync.read(mlPng)
    const xg = PNG.sync.read(xgPng)
    const w = Math.min(ml.width, xg.width)
    const h = Math.min(ml.height, xg.height)
    const mlNorm = cropPng(ml, w, h)
    const xgNorm = cropPng(xg, w, h)

    const buckets = diffBuckets(mlNorm, xgNorm, w, h)
    const totalPx = w * h
    results.push({
      id: view.id, style: view.style, hash: view.hash,
      canvasW: w, canvasH: h, totalPx, buckets,
    })

    // Save the per-view PNGs.
    const viewDir = join(OUT, view.id)
    mkdirSync(viewDir, { recursive: true })
    writeFileSync(join(viewDir, 'maplibre.png'), PNG.sync.write(mlNorm))
    writeFileSync(join(viewDir, 'xgis.png'), PNG.sync.write(xgNorm))
    writeFileSync(join(viewDir, 'buckets.json'), JSON.stringify({
      buckets, totalPx, canvasW: w, canvasH: h,
    }, null, 2))

    // eslint-disable-next-line no-console
    console.log(
      `[pixel-match ${view.id}] eq=${((buckets.eq0 / totalPx) * 100).toFixed(2)}% `
      + `le32=${(((buckets.eq0 + buckets.le8 + buckets.le16 + buckets.le32) / totalPx) * 100).toFixed(2)}% `
      + `gt128=${buckets.gt128}px`,
    )
  })
}

test.afterAll(async () => {
  // Single consolidated report.
  if (results.length === 0) return
  const lines: string[] = []
  lines.push('# Pixel-match survey — X-GIS vs MapLibre')
  lines.push('')
  lines.push('Labels + icons hidden on both sides to isolate fill / line / outline parity.')
  lines.push('')
  lines.push('| View | Identical | ≤8 cumul | ≤32 cumul | ≤128 cumul | >128 px |')
  lines.push('|---|---:|---:|---:|---:|---:|')
  for (const r of results) {
    const t = r.totalPx
    const eq = r.buckets.eq0
    const cle8 = eq + r.buckets.le8
    const cle32 = cle8 + r.buckets.le16 + r.buckets.le32
    const cle128 = cle32 + r.buckets.le64 + r.buckets.le128
    const pct = (n: number) => ((n / t) * 100).toFixed(2) + '%'
    lines.push(
      `| \`${r.id}\` | ${pct(eq)} | ${pct(cle8)} | ${pct(cle32)} | ${pct(cle128)} | ${r.buckets.gt128} |`,
    )
  }
  lines.push('')
  lines.push('## View details')
  for (const view of VIEWS) {
    const r = results.find(rr => rr.id === view.id)
    if (!r) continue
    lines.push('')
    lines.push(`### ${view.id}`)
    lines.push(`- **Style**: \`${view.style}\``)
    lines.push(`- **Hash**: \`${view.hash}\``)
    lines.push(`- **Description**: ${view.description}`)
    lines.push(`- **Canvas**: ${r.canvasW}×${r.canvasH} (${r.totalPx} px)`)
    lines.push(`- **Buckets**: \`${JSON.stringify(r.buckets)}\``)
  }
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n'))
  // eslint-disable-next-line no-console
  console.log(`[pixel-match] consolidated report → ${join(OUT, 'REPORT.md')}`)
})
