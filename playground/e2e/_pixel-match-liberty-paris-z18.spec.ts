// User-requested 2026-05-20: pixel-match vs MapLibre at
// OFM Liberty #18.25/48.84778/2.33194/47.5/49.8.
// Paris z=18.25 pitch=49.8 bearing=47.5 — labels + icons VISIBLE
// (full visual surface, not the labels-hidden survey config).

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__pixel-match-liberty-paris-z18__')
mkdirSync(OUT, { recursive: true })

interface Buckets {
  eq0: number; le8: number; le16: number; le32: number
  le64: number; le128: number; gt128: number
}

function diffBuckets(a: PNG, b: PNG, w: number, h: number): { buckets: Buckets; heatmap: PNG } {
  const buckets: Buckets = { eq0: 0, le8: 0, le16: 0, le32: 0, le64: 0, le128: 0, gt128: 0 }
  const heatmap = new PNG({ width: w, height: h })
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
      // Heatmap: scale max-channel-delta to red intensity. 0 = black,
      // 255 = full red. Easy to spot real divergences vs subpixel AA.
      heatmap.data[i] = m
      heatmap.data[i + 1] = 0
      heatmap.data[i + 2] = 0
      heatmap.data[i + 3] = 255
    }
  }
  return { buckets, heatmap }
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

test('pixel-match liberty Paris z18 pitch=49.8 bearing=47.5', async ({ page }) => {
  test.setTimeout(180_000)
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      // eslint-disable-next-line no-console
      console.warn('[page]', msg.text())
    }
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(
    `/compare.html?style=openfreemap-liberty#18.25/48.84778/2.33194/47.5/49.8`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
      return w.__xgisReady === true && w.__mlReady === true
    },
    null, { timeout: 90_000 },
  )
  // Both sides settle.
  await page.evaluate(() => new Promise<void>((resolve) => {
    interface MlMap { loaded(): boolean; once(ev: string, fn: () => void): void }
    const ml = (window as unknown as { __mlMap?: MlMap }).__mlMap
    if (!ml) { resolve(); return }
    if (ml.loaded()) { resolve(); return }
    ml.once('idle', () => resolve())
    setTimeout(resolve, 12_000)
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
  const mlNorm = cropPng(ml, w, h)
  const xgNorm = cropPng(xg, w, h)

  const { buckets, heatmap } = diffBuckets(mlNorm, xgNorm, w, h)
  const totalPx = w * h
  writeFileSync(join(OUT, 'maplibre.png'), PNG.sync.write(mlNorm))
  writeFileSync(join(OUT, 'xgis.png'), PNG.sync.write(xgNorm))
  writeFileSync(join(OUT, 'diff-heatmap.png'), PNG.sync.write(heatmap))
  writeFileSync(join(OUT, 'buckets.json'), JSON.stringify({
    buckets, totalPx, canvasW: w, canvasH: h,
    hash: '#18.25/48.84778/2.33194/47.5/49.8',
    style: 'openfreemap-liberty',
  }, null, 2))

  const pct = (n: number) => ((n / totalPx) * 100).toFixed(2) + '%'
  const lines: string[] = []
  lines.push('# Pixel-match liberty Paris z18 pitch=49.8 bearing=47.5')
  lines.push('')
  lines.push(`Hash: \`#18.25/48.84778/2.33194/47.5/49.8\``)
  lines.push(`Canvas: ${w}×${h} (${totalPx} px)`)
  lines.push('')
  lines.push('| bucket | px | % |')
  lines.push('|---|---:|---:|')
  lines.push(`| eq0 (identical) | ${buckets.eq0} | ${pct(buckets.eq0)} |`)
  lines.push(`| le8 | ${buckets.le8} | ${pct(buckets.le8)} |`)
  lines.push(`| le16 | ${buckets.le16} | ${pct(buckets.le16)} |`)
  lines.push(`| le32 | ${buckets.le32} | ${pct(buckets.le32)} |`)
  lines.push(`| le64 | ${buckets.le64} | ${pct(buckets.le64)} |`)
  lines.push(`| le128 | ${buckets.le128} | ${pct(buckets.le128)} |`)
  lines.push(`| **gt128 (major divergence)** | **${buckets.gt128}** | **${pct(buckets.gt128)}** |`)
  lines.push('')
  lines.push('## Cumulative')
  const cle8 = buckets.eq0 + buckets.le8
  const cle32 = cle8 + buckets.le16 + buckets.le32
  const cle128 = cle32 + buckets.le64 + buckets.le128
  lines.push(`- ≤8 cumul: ${pct(cle8)}`)
  lines.push(`- ≤32 cumul: ${pct(cle32)}`)
  lines.push(`- ≤128 cumul: ${pct(cle128)}`)
  lines.push('')
  lines.push('## Files')
  lines.push('- `maplibre.png` — MapLibre reference')
  lines.push('- `xgis.png` — X-GIS render')
  lines.push('- `diff-heatmap.png` — max-channel-delta heatmap (red intensity)')
  lines.push('- `buckets.json` — raw counts')
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n'))
  // eslint-disable-next-line no-console
  console.warn(
    `[pixel-match liberty-paris-z18-pitched] eq=${pct(buckets.eq0)} `
    + `le32=${pct(cle32)} gt128=${buckets.gt128}px`,
  )
  expect(totalPx).toBeGreaterThan(0)
})
