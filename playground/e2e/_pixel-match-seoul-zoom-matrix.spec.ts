// X-GIS ↔ MapLibre pixel-diff matrix at Seoul, zooms × pitches.
//
// User request 2026-05-20: MapLibre compare across zoom + pitch.
// MapLibre v3 supports mercator (default) + globe natively. The
// X-GIS other projections (equirect, NE, ortho, azi, stereo,
// oblique) have no direct MapLibre equivalent — apples-to-oranges,
// so this spec covers ONLY mercator at this stage (the dominant
// target style + the comparable baseline). Globe compare is a
// separate follow-up unit (needs compare.html projection routing
// + projection: 'globe' MapLibre init).
//
// Matrix: zoom {0, 4, 8, 12, 16, 19} × pitch {0, 60} = 12 cells.
// Output: __pixel-match-seoul-zoom-matrix__/REPORT.md +
// per-cell PNGs (xgis.png, maplibre.png, buckets.json).

import { test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__pixel-match-seoul-zoom-matrix__')
mkdirSync(OUT, { recursive: true })

const SEOUL = { lon: 126.9776, lat: 37.5558 }
const ZOOMS = [0, 4, 8, 12, 16, 19] as const
const PITCHES = [0, 60] as const

interface Buckets {
  eq0: number; le8: number; le16: number; le32: number
  le64: number; le128: number; gt128: number
}

function diffBuckets(a: PNG, b: PNG, w: number, h: number): Buckets {
  const b_ = { eq0: 0, le8: 0, le16: 0, le32: 0, le64: 0, le128: 0, gt128: 0 }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const dr = Math.abs(a.data[i]! - b.data[i]!)
      const dg = Math.abs(a.data[i + 1]! - b.data[i + 1]!)
      const db = Math.abs(a.data[i + 2]! - b.data[i + 2]!)
      const m = Math.max(dr, dg, db)
      if (m === 0) b_.eq0++
      else if (m <= 8) b_.le8++
      else if (m <= 16) b_.le16++
      else if (m <= 32) b_.le32++
      else if (m <= 64) b_.le64++
      else if (m <= 128) b_.le128++
      else b_.gt128++
    }
  }
  return b_
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

async function hideSymbolLayers(page: Page): Promise<void> {
  // Same approach as _pixel-match-survey: hide labels both sides so
  // label-AA + font-driver differences don't dominate the diff.
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
  await page.waitForTimeout(3_500)
  await page.evaluate(() => new Promise<void>(r =>
    requestAnimationFrame(() => requestAnimationFrame(() => r()))))
}

interface CellResult {
  zoom: number; pitch: number
  canvasW: number; canvasH: number; totalPx: number
  buckets: Buckets
}
const results: CellResult[] = []

test.describe.configure({ mode: 'serial' })

test.describe('pixel-match-seoul-zoom-matrix (mercator only)', () => {
  for (const zoom of ZOOMS) {
    for (const pitch of PITCHES) {
      test(`z=${zoom} pitch=${pitch}`, async ({ page }) => {
        test.setTimeout(180_000)
        await page.setViewportSize({ width: 1280, height: 800 })
        const hash = `#${zoom}/${SEOUL.lat}/${SEOUL.lon}/0/${pitch}`
        await page.goto(
          `/compare.html?style=openfreemap-bright${hash}`,
          { waitUntil: 'domcontentloaded' },
        )
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

        results.push({ zoom, pitch, canvasW: w, canvasH: h, totalPx, buckets })

        const cellDir = join(OUT, `z${zoom}-p${pitch}`)
        mkdirSync(cellDir, { recursive: true })
        writeFileSync(join(cellDir, 'maplibre.png'), PNG.sync.write(mlNorm))
        writeFileSync(join(cellDir, 'xgis.png'), PNG.sync.write(xgNorm))
        writeFileSync(join(cellDir, 'buckets.json'), JSON.stringify({
          buckets, totalPx, canvasW: w, canvasH: h,
        }, null, 2))

        const le32 = buckets.eq0 + buckets.le8 + buckets.le16 + buckets.le32
        // eslint-disable-next-line no-console
        console.log(
          `[matrix z=${zoom} p=${pitch}] eq=${((buckets.eq0 / totalPx) * 100).toFixed(2)}% `
          + `le32=${((le32 / totalPx) * 100).toFixed(2)}% gt128=${buckets.gt128}px`,
        )
      })
    }
  }

  test.afterAll(() => {
    if (results.length === 0) return
    const lines: string[] = []
    lines.push('# X-GIS ↔ MapLibre pixel-diff matrix — Seoul × zoom × pitch (mercator)')
    lines.push('')
    lines.push(`Run: ${new Date().toISOString()}`)
    lines.push(`Coord: ${SEOUL.lon}, ${SEOUL.lat}; OFM bright; symbol layers hidden`)
    lines.push('')
    lines.push('Buckets: per-pixel max-channel abs delta vs MapLibre.')
    lines.push('eq=byte-identical; le32=visually-indistinguishable; gt128=visible divergence.')
    lines.push('')
    lines.push('| Zoom | Pitch | Canvas | eq% | le32% | gt128 px |')
    lines.push('|---:|---:|---:|---:|---:|---:|')
    for (const r of results) {
      const le32 = r.buckets.eq0 + r.buckets.le8 + r.buckets.le16 + r.buckets.le32
      lines.push(
        `| ${r.zoom} | ${r.pitch}° | ${r.canvasW}×${r.canvasH} | `
        + `${((r.buckets.eq0 / r.totalPx) * 100).toFixed(2)} | `
        + `${((le32 / r.totalPx) * 100).toFixed(2)} | ${r.buckets.gt128} |`,
      )
    }
    lines.push('')
    lines.push('Globe + non-Merc projection compare is a separate follow-up')
    lines.push('(needs compare-runner projection routing + MapLibre globe init).')
    writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n'))
    // eslint-disable-next-line no-console
    console.log(`[matrix] REPORT → ${join(OUT, 'REPORT.md')}`)
  })
})
