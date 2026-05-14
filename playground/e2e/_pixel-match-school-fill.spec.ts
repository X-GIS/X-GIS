// ═══════════════════════════════════════════════════════════════════
// Pixel matching: OFM Bright school fill, labels + icons OFF
// ═══════════════════════════════════════════════════════════════════
//
// Re-measure the user-reported parity gap at
//   #17.85/37.12665/126.92430 (행정초등학교 area)
// after the P1 school-fill fix chain (5 commits, 2026-05-14).
//
// Labels + icons are hidden on BOTH sides so the comparison isolates
// the fill / line / outline parity. Prior measurement reported 76.2%
// identical / 98.6% within 32-RGB delta; target after fix is ≥95%
// identical / ≥99% within small delta.

import { test, expect } from '@playwright/test'

// Pixel-match specs run serially. Multiple parallel WebGPU contexts
// thrash the adapter — measurements showed 4 workers running pixel
// match concurrently became >2× slower than serial. Same gate
// applies to every _pixel-match-*.spec.ts file.
test.describe.configure({ mode: 'serial' })
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__pixel-match-school-fill__')
mkdirSync(OUT, { recursive: true })

test('ofm-bright school fill pixel match — labels off', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(
    `/compare.html?style=openfreemap-bright#17.85/37.12665/126.92430`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
      return w.__xgisReady === true && w.__mlReady === true
    },
    null, { timeout: 60_000 },
  )

  // Hide every symbol (text + icon) layer on the MapLibre side.
  await page.evaluate(() => {
    interface MlMap {
      getStyle(): { layers: Array<{ id: string; type: string }> }
      setLayoutProperty(id: string, key: string, value: 'none' | 'visible'): void
    }
    const ml = (window as unknown as { __mlMap?: MlMap }).__mlMap
    if (!ml) return
    const layers = ml.getStyle().layers
    for (const layer of layers) {
      if (layer.type === 'symbol') {
        ml.setLayoutProperty(layer.id, 'visibility', 'none')
      }
    }
  })

  // Hide every X-GIS layer whose source-of-truth carries a label
  // (text) or whose declared shape is a billboard sprite (icon).
  // Goes through the internal `vectorTileShows` (text labels) +
  // `commands.shows` (point/symbol shows) to flip visibility.
  const xgisHidden = await page.evaluate(() => {
    interface XGISShow {
      label?: unknown
      shape?: string | null
      sourceLayer?: string
      layerName?: string
      targetName: string
      visible?: boolean
    }
    interface XGISLayer { style?: { visible?: boolean } }
    interface XGISMap {
      vectorTileShows?: Array<{ show: XGISShow }>
      commands?: { shows: XGISShow[] }
      getLayers?(): readonly XGISLayer[]
      invalidate?(): void
    }
    const map = (window as unknown as { __xgisMap?: XGISMap }).__xgisMap
    if (!map) return { hidden: 0, total: 0 }
    let hidden = 0
    let total = 0
    // 1) Vector-tile shows with declared labels — label-only render shows.
    for (const entry of map.vectorTileShows ?? []) {
      total++
      if (entry.show.label !== undefined) {
        entry.show.visible = false
        hidden++
      }
    }
    // 2) Public XGISLayer wrappers (covers point/icon shows whose
    //    `shape` is a named sprite — OFM Bright POI markers etc.).
    for (const layer of map.getLayers?.() ?? []) {
      if (!layer.style) continue
      // The compiler doesn't surface "is this a symbol layer" cleanly,
      // so use a heuristic: any layer whose name contains 'label',
      // 'icon', 'poi', 'name', or 'symbol' is treated as a symbol-
      // class draw and hidden. False positives are OK for this probe
      // (we want labels/icons off, full stop).
      const name = ((layer as unknown as { name?: string }).name ?? '').toLowerCase()
      if (/label|icon|poi|name|symbol|aerodrome|housenumber/.test(name)) {
        layer.style.visible = false
        hidden++
      }
    }
    map.invalidate?.()
    return { hidden, total }
  })
  // eslint-disable-next-line no-console
  console.log('[pixel-match] hidden symbols:', xgisHidden)

  // Wait for both sides to settle after the visibility change.
  await page.evaluate(() => new Promise<void>((resolve) => {
    interface MlMap { loaded(): boolean; once(ev: string, fn: () => void): void }
    const ml = (window as unknown as { __mlMap?: MlMap }).__mlMap
    if (!ml) { resolve(); return }
    if (ml.loaded()) { resolve(); return }
    ml.once('idle', () => resolve())
    setTimeout(resolve, 15_000)
  }))
  await page.waitForTimeout(4_000)
  await page.evaluate(() => new Promise<void>(r =>
    requestAnimationFrame(() => requestAnimationFrame(() => r()))))

  const mlPng = await page.locator('#ml-map canvas').first().screenshot()
  const xgPng = await page.locator('#xg-canv').screenshot()
  const ml = PNG.sync.read(mlPng)
  const xg = PNG.sync.read(xgPng)
  const w = Math.min(ml.width, xg.width)
  const h = Math.min(ml.height, xg.height)
  const cropped = (src: PNG, ww: number, hh: number): PNG => {
    if (src.width === ww && src.height === hh) return src
    const out = new PNG({ width: ww, height: hh })
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < ww; x++) {
        const si = (y * src.width + x) * 4
        const di = (y * ww + x) * 4
        out.data[di] = src.data[si]!
        out.data[di + 1] = src.data[si + 1]!
        out.data[di + 2] = src.data[si + 2]!
        out.data[di + 3] = src.data[si + 3]!
      }
    }
    return out
  }
  const mlNorm = cropped(ml, w, h)
  const xgNorm = cropped(xg, w, h)

  // Per-pixel histogram of max-channel delta (R/G/B). Captures the
  // shape of the difference distribution: how many pixels are
  // identical, ≤8, ≤16, ≤32, ≤64, ≤128, >128.
  const totalPx = w * h
  const buckets = { eq0: 0, le8: 0, le16: 0, le32: 0, le64: 0, le128: 0, gt128: 0 }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const dr = Math.abs(mlNorm.data[i]! - xgNorm.data[i]!)
      const dg = Math.abs(mlNorm.data[i + 1]! - xgNorm.data[i + 1]!)
      const db = Math.abs(mlNorm.data[i + 2]! - xgNorm.data[i + 2]!)
      const max = Math.max(dr, dg, db)
      if (max === 0) buckets.eq0++
      else if (max <= 8) buckets.le8++
      else if (max <= 16) buckets.le16++
      else if (max <= 32) buckets.le32++
      else if (max <= 64) buckets.le64++
      else if (max <= 128) buckets.le128++
      else buckets.gt128++
    }
  }
  const pct = (n: number) => ((n / totalPx) * 100).toFixed(2) + '%'
  const cum = (...keys: Array<keyof typeof buckets>) => {
    let n = 0
    for (const k of keys) n += buckets[k]
    return pct(n)
  }
  const report = {
    camera: '#17.85/37.12665/126.92430',
    style: 'openfreemap-bright',
    canvas: `${w}x${h}`,
    totalPx,
    symbolsHidden: xgisHidden,
    buckets,
    cumulative: {
      identical: pct(buckets.eq0),
      le8: cum('eq0', 'le8'),
      le16: cum('eq0', 'le8', 'le16'),
      le32: cum('eq0', 'le8', 'le16', 'le32'),
      le64: cum('eq0', 'le8', 'le16', 'le32', 'le64'),
      le128: cum('eq0', 'le8', 'le16', 'le32', 'le64', 'le128'),
    },
  }
  // eslint-disable-next-line no-console
  console.log('[pixel-match] report:', JSON.stringify(report, null, 2))

  // Pixelmatch diff PNG for visual eyeballing (red where it differs).
  const diff = new PNG({ width: w, height: h })
  const diffPixels = pixelmatch(mlNorm.data, xgNorm.data, diff.data, w, h,
    { threshold: 0.15, includeAA: false })

  writeFileSync(join(OUT, 'ml.png'), PNG.sync.write(mlNorm))
  writeFileSync(join(OUT, 'xg.png'), PNG.sync.write(xgNorm))
  writeFileSync(join(OUT, 'diff.png'), PNG.sync.write(diff))
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(OUT, 'pixelmatch.json'), JSON.stringify({
    diffPixels,
    diffRatio: diffPixels / totalPx,
    threshold: 0.15,
  }, null, 2))

  // No hard gate — this is a measurement, not a regression test.
  // The report.json is the contract.
  expect(report.totalPx).toBeGreaterThan(0)
})
