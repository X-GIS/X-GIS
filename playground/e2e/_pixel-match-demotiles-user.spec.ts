// ═══════════════════════════════════════════════════════════════════
// User-requested pixel match — demotiles ?compute=1 z=9.45 China
// ═══════════════════════════════════════════════════════════════════
//
// URL: /compare.html?style=maplibre-demotiles&compute=1
//       #9.45/32.14379/119.97235
//
// Tests both compute modes against MapLibre at the user-specified
// view + saves diff visualisations under
// __pixel-match-demotiles-user__/.

import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__pixel-match-demotiles-user__')
mkdirSync(OUT, { recursive: true })

const VIEW_HASH = '#9.45/32.14379/119.97235'
const TIMEOUT = 60_000

interface Buckets {
  eq0: number; le8: number; le16: number; le32: number
  le64: number; le128: number; gt128: number
}

function diffBuckets(a: PNG, b: PNG): { buckets: Buckets; total: number; w: number; h: number } {
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  const buckets: Buckets = { eq0: 0, le8: 0, le16: 0, le32: 0, le64: 0, le128: 0, gt128: 0 }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ai = (y * a.width + x) * 4
      const bi = (y * b.width + x) * 4
      const m = Math.max(
        Math.abs(a.data[ai]! - b.data[bi]!),
        Math.abs(a.data[ai+1]! - b.data[bi+1]!),
        Math.abs(a.data[ai+2]! - b.data[bi+2]!),
      )
      if (m === 0) buckets.eq0++
      else if (m <= 8) buckets.le8++
      else if (m <= 16) buckets.le16++
      else if (m <= 32) buckets.le32++
      else if (m <= 64) buckets.le64++
      else if (m <= 128) buckets.le128++
      else buckets.gt128++
    }
  }
  return { buckets, total: w * h, w, h }
}

function buildDiffHeatmap(a: PNG, b: PNG, w: number, h: number): PNG {
  const out = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ai = (y * a.width + x) * 4
      const bi = (y * b.width + x) * 4
      const oi = (y * w + x) * 4
      const m = Math.max(
        Math.abs(a.data[ai]! - b.data[bi]!),
        Math.abs(a.data[ai+1]! - b.data[bi+1]!),
        Math.abs(a.data[ai+2]! - b.data[bi+2]!),
      )
      if (m === 0) {
        out.data[oi] = 0; out.data[oi+1] = 0; out.data[oi+2] = 0
      } else {
        const intensity = Math.min(255, m * 2)
        out.data[oi] = intensity
        out.data[oi+1] = 64 - Math.min(64, m/2)
        out.data[oi+2] = 64 - Math.min(64, m/2)
      }
      out.data[oi+3] = 255
    }
  }
  return out
}

async function loadAndCapture(page: import('@playwright/test').Page, compute: 0 | 1) {
  const computeQuery = compute === 1 ? '&compute=1' : ''
  await page.goto(`/compare.html?style=maplibre-demotiles${computeQuery}${VIEW_HASH}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
      return w.__xgisReady === true && w.__mlReady === true
    },
    null, { timeout: TIMEOUT },
  )

  // Hide ML symbol layers
  await page.evaluate(() => {
    interface MlMap {
      getStyle(): { layers: Array<{ id: string; type: string }> }
      setLayoutProperty(id: string, key: string, value: 'none' | 'visible'): void
    }
    const ml = (window as unknown as { __mlMap?: MlMap }).__mlMap
    if (!ml) return
    for (const layer of ml.getStyle().layers) {
      if (layer.type === 'symbol') ml.setLayoutProperty(layer.id, 'visibility', 'none')
    }
  })
  // Hide X-GIS labels/icons
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
      if (/label|icon|poi|name|symbol/.test(name)) layer.style.visible = false
    }
    map.invalidate?.()
  })

  await page.waitForTimeout(4_000)
  await page.evaluate(() => new Promise<void>(r =>
    requestAnimationFrame(() => requestAnimationFrame(() => r()))))

  const mlBuf = await page.locator('#ml-map canvas').first().screenshot()
  const xgBuf = await page.locator('#xg-canv').screenshot()
  return { ml: PNG.sync.read(mlBuf), xg: PNG.sync.read(xgBuf) }
}

function fmt(b: Buckets, total: number): string {
  const pct = (n: number) => ((n / total) * 100).toFixed(2) + '%'
  const cum32 = b.eq0 + b.le8 + b.le16 + b.le32
  const cum128 = cum32 + b.le64 + b.le128
  return `eq=${pct(b.eq0)} ≤32=${pct(cum32)} ≤128=${pct(cum128)} gt128=${b.gt128}px`
}

for (const compute of [0, 1] as const) {
  test(`demotiles z=9.45 China — compute=${compute} vs MapLibre`, async ({ page }) => {
    test.setTimeout(TIMEOUT + 30_000)
    const { ml, xg } = await loadAndCapture(page, compute)
    const { buckets, total, w, h } = diffBuckets(ml, xg)
    const tag = `compute${compute}`
    writeFileSync(join(OUT, `${tag}-ml.png`), PNG.sync.write(ml))
    writeFileSync(join(OUT, `${tag}-xg.png`), PNG.sync.write(xg))
    writeFileSync(join(OUT, `${tag}-diff.png`), PNG.sync.write(buildDiffHeatmap(ml, xg, w, h)))
    writeFileSync(join(OUT, `${tag}-buckets.json`), JSON.stringify({
      compute, total, w, h, buckets,
      cumulative: {
        identical: ((buckets.eq0 / total) * 100).toFixed(2) + '%',
        le32:      (((buckets.eq0 + buckets.le8 + buckets.le16 + buckets.le32) / total) * 100).toFixed(2) + '%',
        le128:     (((buckets.eq0 + buckets.le8 + buckets.le16 + buckets.le32 + buckets.le64 + buckets.le128) / total) * 100).toFixed(2) + '%',
      },
    }, null, 2))
    // eslint-disable-next-line no-console
    console.log(`[demotiles user compute=${compute}] ${w}×${h}  ${fmt(buckets, total)}`)
  })
}
