// ═══════════════════════════════════════════════════════════════════
// Pixel-match survey WITH labels — measures text/icon/halo parity
// ═══════════════════════════════════════════════════════════════════
//
// Companion to `_pixel-match-survey.spec.ts`. That spec hides symbol
// layers on both sides ("Labels + icons hidden on both sides to
// isolate fill / line / outline parity"), which means label / icon
// regressions are not auto-detected — exactly the gap surfaced by
// the 2026-05-18 user report ("아이콘 누락되어 렌더링되는게 있음,
// 텍스트 또한 실제보다 폰트가 작아보이거나 얇아보임, 할로 크기/블러
// 검토 필요").
//
// This sibling spec keeps the SAME 4 views, the SAME bucket grid,
// and the SAME REPORT.md format, but does NOT call hideSymbolLayers.
// The two artifact trees (`__pixel-match-survey__/` and
// `__pixel-match-survey-labels__/`) sit side-by-side so any label
// / icon / halo drift surfaces as a delta between the two tables.
//
// No new measurement library — reuses pngjs / Playwright already in
// the project per user direction (2026-05-18 "모든 측정 라이브러리는
// 이미 존재하므로 코드베이스에서 적절히 수행 권장").

import { test } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__pixel-match-survey-labels__')
mkdirSync(OUT, { recursive: true })

interface ViewSpec {
  id: string
  style: string
  hash: string
  description: string
}

// SAME 4 views as the labels-off survey, so the two REPORT.md files
// align row-for-row. Thresholds are NOT applied here — this spec is
// purely measurement; the labels-off spec already gates polygon
// drift, and label work hasn't yet been tightened to a budget. Once
// the icon pipeline (Phase C of the compat plan) lands we'll add
// thresholds here too.
const VIEWS: ViewSpec[] = [
  { id: 'bright-seoul-school',
    style: 'openfreemap-bright',
    hash: '#17.85/37.12665/126.92430',
    description: 'OFM Bright, Seoul 행정초등학교 — label + icon parity at z=17.85' },
  { id: 'bright-tokyo-z14',
    style: 'openfreemap-bright',
    hash: '#14/35.6585/139.7454',
    description: 'OFM Bright, Tokyo z=14 — POI icons + place labels' },
  { id: 'liberty-paris-z14',
    style: 'openfreemap-liberty',
    hash: '#14/48.8534/2.3488',
    description: 'OFM Liberty, Paris z=14 — dense label network + icons' },
  { id: 'demotiles-europe-z2',
    style: 'maplibre-demotiles',
    hash: '#2.5/48/15',
    description: 'MapLibre demotiles, Europe z=2 — country labels (Bold weight)' },
]

interface Buckets {
  eq0: number; le8: number; le16: number; le32: number
  le64: number; le128: number; gt128: number
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
  test(`pixel-match-labels ${view.id}`, async ({ page }) => {
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
    // Intentionally NO hideSymbolLayers — that's the whole point of
    // this spec. Both sides keep labels + icons visible so the diff
    // captures text / halo / icon parity.
    //
    // Settle wait: labels rely on glyph PBF fetches that can lag
    // behind the polygon paint. Wait a beat longer than the labels-
    // off survey to let the label collision pass converge.
    await page.evaluate(() => new Promise<void>((resolve) => {
      interface MlMap { loaded(): boolean; once(ev: string, fn: () => void): void }
      const ml = (window as unknown as { __mlMap?: MlMap }).__mlMap
      if (!ml) { resolve(); return }
      if (ml.loaded()) { resolve(); return }
      ml.once('idle', () => resolve())
      setTimeout(resolve, 15_000)
    }))
    await page.waitForTimeout(4_500)
    await page.evaluate(() => new Promise<void>(r =>
      requestAnimationFrame(() => requestAnimationFrame(() => r()))))

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

    const viewDir = join(OUT, view.id)
    mkdirSync(viewDir, { recursive: true })
    writeFileSync(join(viewDir, 'maplibre.png'), PNG.sync.write(mlNorm))
    writeFileSync(join(viewDir, 'xgis.png'), PNG.sync.write(xgNorm))
    writeFileSync(join(viewDir, 'buckets.json'), JSON.stringify({
      buckets, totalPx, canvasW: w, canvasH: h,
    }, null, 2))

    // eslint-disable-next-line no-console
    console.log(
      `[pixel-match-labels ${view.id}] eq=${((buckets.eq0 / totalPx) * 100).toFixed(2)}% `
      + `gt128=${buckets.gt128}px`,
    )
  })
}

test.afterAll(async () => {
  if (results.length === 0) return
  const lines: string[] = []
  lines.push('# Pixel-match survey (labels + icons VISIBLE) — X-GIS vs MapLibre')
  lines.push('')
  lines.push('Sibling of `__pixel-match-survey__/REPORT.md`. Labels + icons')
  lines.push('are LEFT VISIBLE on both sides so the diff captures text /')
  lines.push('halo / icon parity. Compare row-for-row against the labels-off')
  lines.push('table to isolate label / icon drift from polygon drift.')
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
  console.log(`[pixel-match-labels] consolidated report → ${join(OUT, 'REPORT.md')}`)
})
