// Pixel-match for user-reported visual-difference views.
// Sweeps Liberty z=4.96 Korea, z=10 Gangwon, z=17.5 highway,
// z=19.49 Tokyo. Writes ML / XG / DIFF PNGs and a buckets report
// so the user can SEE what's different and we can investigate
// specific deltas.
import { test, expect } from '@playwright/test'
test.describe.configure({ mode: 'serial' })

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__pixel-match-user-views__')
mkdirSync(OUT, { recursive: true })

interface ViewSpec {
  id: string
  style: string
  hash: string
  /** What the user noted is wrong; kept here so the report row carries
   *  context next to the buckets row. */
  expected: string
  /** Hide symbol layers? Default false — we WANT to see label parity. */
  hideLabels?: boolean
}

const VIEWS: ViewSpec[] = [
  { id: 'liberty-korea-z5',
    style: 'openfreemap-liberty',
    hash: '#4.96/36.91054/128.15566/0.8/1.0',
    expected: 'anchor + multiline wrap (just fixed)' },
  { id: 'liberty-gangwon-z10',
    style: 'openfreemap-liberty',
    hash: '#10.10/37.35371/128.17283',
    expected: 'stroke + dash patterns' },
  { id: 'liberty-highway-z175',
    style: 'openfreemap-liberty',
    hash: '#17.50/37.44536/128.10118',
    expected: 'orange motorway extra middle line' },
  { id: 'liberty-tokyo-z19',
    style: 'openfreemap-liberty',
    hash: '#19.49/35.87387/139.95634',
    expected: 'missing river / drainage / road-name labels' },
]

interface Buckets {
  eq0: number; le8: number; le16: number; le32: number
  le64: number; le128: number; gt128: number
}

function diffBuckets(a: PNG, b: PNG, w: number, h: number): { buckets: Buckets; diffPng: PNG } {
  const buckets: Buckets = { eq0: 0, le8: 0, le16: 0, le32: 0, le64: 0, le128: 0, gt128: 0 }
  const diff = new PNG({ width: w, height: h })
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
      // Diff PNG: greyscale base of ML (context), tiered colour
      // overlay by severity so the user sees the BIG differences
      // clearly without low-delta noise:
      //   delta ≤ 32  → gray (visually equivalent)
      //   32 < d ≤ 64 → light orange (small drift)
      //   64 < d ≤ 128 → orange (visible)
      //   d > 128      → bright red (clearly different)
      const gray = (a.data[i]! + a.data[i + 1]! + a.data[i + 2]!) / 3 * 0.4 + 80
      if (m <= 32) {
        diff.data[i] = gray; diff.data[i + 1] = gray; diff.data[i + 2] = gray
      } else if (m <= 64) {
        diff.data[i] = 240; diff.data[i + 1] = 200; diff.data[i + 2] = 120
      } else if (m <= 128) {
        diff.data[i] = 250; diff.data[i + 1] = 150; diff.data[i + 2] = 60
      } else {
        diff.data[i] = 255; diff.data[i + 1] = 50; diff.data[i + 2] = 50
      }
      diff.data[i + 3] = 255
    }
  }
  return { buckets, diffPng: diff }
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
  hash: string
  expected: string
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
    // Wait for MapLibre's idle + a settle window for PBF glyph fetches.
    await page.evaluate(() => new Promise<void>((resolve) => {
      interface MlMap { loaded(): boolean; once(ev: string, fn: () => void): void }
      const ml = (window as unknown as { __mlMap?: MlMap }).__mlMap
      if (!ml) { resolve(); return }
      if (ml.loaded()) { resolve(); return }
      ml.once('idle', () => resolve())
      setTimeout(resolve, 12_000)
    }))
    // Longer settle than the standard survey — at higher zooms the
    // PBF glyph ranges for non-Latin text take 5-10 s to land and
    // X-GIS renders them invisible (zero SDF) until atlas.invalidate
    // fires the next-frame upgrade. Without the wait the diff is
    // dominated by "labels exist on ML, blank on XG" noise.
    await page.waitForTimeout(12_000)
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

    const { buckets, diffPng } = diffBuckets(mlNorm, xgNorm, w, h)
    const totalPx = w * h
    results.push({
      id: view.id, hash: view.hash, expected: view.expected,
      canvasW: w, canvasH: h, totalPx, buckets,
    })

    const viewDir = join(OUT, view.id)
    mkdirSync(viewDir, { recursive: true })
    writeFileSync(join(viewDir, 'maplibre.png'), PNG.sync.write(mlNorm))
    writeFileSync(join(viewDir, 'xgis.png'), PNG.sync.write(xgNorm))
    writeFileSync(join(viewDir, 'diff.png'), PNG.sync.write(diffPng))
    writeFileSync(join(viewDir, 'buckets.json'), JSON.stringify({
      buckets, totalPx, canvasW: w, canvasH: h, hash: view.hash,
    }, null, 2))

    // eslint-disable-next-line no-console
    console.log(
      `[${view.id}] eq=${((buckets.eq0 / totalPx) * 100).toFixed(2)}% `
      + `le32=${(((buckets.eq0 + buckets.le8 + buckets.le16 + buckets.le32) / totalPx) * 100).toFixed(2)}% `
      + `gt128=${buckets.gt128}px (${((buckets.gt128 / totalPx) * 100).toFixed(2)}%)`,
    )
  })
}

test.afterAll(async () => {
  if (results.length === 0) return
  const lines: string[] = []
  lines.push('# Pixel-match — user-reported views')
  lines.push('')
  lines.push('Labels visible (we want to compare full rendering including text).')
  lines.push('')
  lines.push('| View | Hash | Identical | ≤8 cumul | ≤32 cumul | ≤128 cumul | >128 px | What |')
  lines.push('|---|---|---:|---:|---:|---:|---:|---|')
  for (const r of results) {
    const t = r.totalPx
    const eq = r.buckets.eq0
    const cle8 = eq + r.buckets.le8
    const cle32 = cle8 + r.buckets.le16 + r.buckets.le32
    const cle128 = cle32 + r.buckets.le64 + r.buckets.le128
    lines.push(
      `| ${r.id} | \`${r.hash}\` | ${((eq / t) * 100).toFixed(2)}% | `
      + `${((cle8 / t) * 100).toFixed(2)}% | ${((cle32 / t) * 100).toFixed(2)}% | `
      + `${((cle128 / t) * 100).toFixed(2)}% | ${r.buckets.gt128.toLocaleString()} | ${r.expected} |`,
    )
  }
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n'))
  // eslint-disable-next-line no-console
  console.log(`\nReport saved to ${join(OUT, 'REPORT.md')}\n`)
  expect(true).toBe(true)
})
