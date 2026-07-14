// Buildings-only pixel-diff harness — iter-192 follow-up.
//
// User requested an isolated test environment so visual divergence
// from MapLibre traces to the fill-extrusion pipeline alone. The
// stripped style `liberty-buildings-only` keeps only background +
// flat building fill + 3D building extrusion (fill-extrusion-opacity
// 0.8). Everything else (roads, landuse, POI, labels, raster) is
// removed at the source so neither engine has noise contributing
// to the diff.
//
// Usage in browser: https://localhost:3000/compare.html?style=liberty-buildings-only#18.25/48.84778/2.33194/47.5/49.8

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__pixel-match-buildings-only__')
mkdirSync(OUT, { recursive: true })

interface Buckets {
  eq0: number
  le8: number
  le16: number
  le32: number
  le64: number
  le128: number
  gt128: number
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

interface View {
  id: string
  hash: string
  description: string
}

const VIEWS: View[] = [
  {
    id: 'paris-z18-pitch49-bearing47',
    hash: '#18.25/48.84778/2.33194/47.5/49.8',
    description: 'User-reported view — Paris Quartier Latin, pitched bearing',
  },
  {
    id: 'paris-z18-pitch60-bearing0',
    hash: '#18.25/48.84778/2.33194/0/60',
    description: 'Higher pitch, no bearing — pure foreshortening',
  },
  {
    id: 'paris-z16-pitch30',
    hash: '#16/48.85/2.34/0/30',
    description: 'Lower zoom + low pitch — building density mid-range',
  },
]

for (const view of VIEWS) {
  test(`buildings-only ${view.id}`, async ({ page }) => {
    test.setTimeout(180_000)
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        console.warn('[page]', msg.text())
      }
    })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/compare.html?style=liberty-buildings-only${view.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
        return w.__xgisReady === true && w.__mlReady === true
      },
      null,
      { timeout: 90_000 },
    )
    // Settle both sides.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          interface MlMap {
            loaded(): boolean
            once(ev: string, fn: () => void): void
          }
          const ml = (window as unknown as { __mlMap?: MlMap }).__mlMap
          if (!ml) {
            resolve()
            return
          }
          if (ml.loaded()) {
            resolve()
            return
          }
          ml.once('idle', () => resolve())
          setTimeout(resolve, 12_000)
        }),
    )
    await page.waitForTimeout(10_000) // settle — z=18 takes time to load all extruded building tiles
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    )

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
    const viewDir = join(OUT, view.id)
    mkdirSync(viewDir, { recursive: true })
    writeFileSync(join(viewDir, 'maplibre.png'), PNG.sync.write(mlNorm))
    writeFileSync(join(viewDir, 'xgis.png'), PNG.sync.write(xgNorm))
    writeFileSync(join(viewDir, 'diff-heatmap.png'), PNG.sync.write(heatmap))
    writeFileSync(
      join(viewDir, 'buckets.json'),
      JSON.stringify(
        {
          buckets,
          totalPx,
          canvasW: w,
          canvasH: h,
          hash: view.hash,
          description: view.description,
        },
        null,
        2,
      ),
    )

    const pct = (n: number) => ((n / totalPx) * 100).toFixed(2) + '%'

    console.warn(
      `[buildings-only ${view.id}] eq=${pct(buckets.eq0)} ` +
        `≤8=${pct(buckets.eq0 + buckets.le8)} ` +
        `≤32=${pct(buckets.eq0 + buckets.le8 + buckets.le16 + buckets.le32)} ` +
        `gt128=${buckets.gt128}`,
    )
    expect(totalPx).toBeGreaterThan(0)
  })
}
