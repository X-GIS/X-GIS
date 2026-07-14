// Non-Mercator screenshot intrinsic analysis (Seoul, zoom × pitch).
//
// User request 2026-05-20: MapLibre pixel-diff impossible for the 6
// non-Mercator projections (equirect/NE/ortho/azi/stereo/oblique —
// MapLibre supports only mercator+globe natively). For those,
// screenshot-only intrinsic analysis: did X-GIS actually render
// content at this cell? sparse/blank/uniform = render gap; rich
// pixel distribution = healthy.
//
// Per cell (6 proj × 2 pitch × 5 zoom = 60 cells, ~8 min):
//   - Load X-GIS canvas at the cell, settle
//   - Screenshot, save PNG
//   - Compute intrinsic metrics:
//       bgFraction  = pixels matching OFM bright bg (#f8f4f0 ±8)
//       nonBgPx     = total - bgPx
//       uniqueBuckets = count of 4×4-bit-quantised RGB buckets
//                       (rich render → many; blank → few)
//       channelStd  = sqrt(variance) of luminance across pixels
//                     (low = uniform/blank, high = rich content)
//   - Output REPORT.md matrix; per-cell PNG for visual inspection
//
// No external reference needed; this catches the render-fail /
// sparse-render class (the #2/#3 globe/oblique pattern, now fixed
// iter-144/149) WITHOUT needing MapLibre.

import { test, type Page } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(HERE, '__convert-fixtures', 'bright.json'), 'utf8')
const OUT = resolve(HERE, '__screenshot-non-merc-seoul-matrix__')
mkdirSync(OUT, { recursive: true })

const SEOUL = { lon: 126.9776, lat: 37.5558 }
const PROJECTIONS = [
  'equirectangular',
  'natural_earth',
  'orthographic',
  'azimuthal_equidistant',
  'stereographic',
  'oblique_mercator',
] as const
const ZOOMS = [0, 4, 8, 14, 19] as const
const PITCHES = [0, 60] as const

// OFM bright background colour `#f8f4f0` = (248, 244, 240).
const BG = { r: 248, g: 244, b: 240 }
const BG_TOL = 8 // ±8 per channel — absorbs raster jitter / AA bleed.

interface CellMetrics {
  projection: string
  zoom: number
  pitch: number
  width: number
  height: number
  totalPx: number
  bgPx: number
  bgFraction: number
  nonBgPx: number
  /** 4×4×4-bit-quantised unique RGB buckets present in the image.
   *  Blank-or-uniform render = a handful; rich render = hundreds. */
  uniqueBuckets: number
  /** Luminance standard deviation across all pixels. Low (≲ 5) ⇒
   *  near-uniform image ⇒ likely render-fail or sparse-render. */
  luminanceStd: number
  /** Per-cell pass/fail flag. Lenient: a cell PASSES if (a) it is
   *  not predominantly background AND (b) it has reasonable colour
   *  diversity. Used only for the REPORT summary — no hard
   *  assertion (non-Merc behaviour is intentionally informational
   *  for now). */
  looksRendered: boolean
}

function analyseScreenshot(buf: Buffer): Omit<CellMetrics, 'projection' | 'zoom' | 'pitch'> {
  const png = PNG.sync.read(buf)
  const w = png.width,
    h = png.height
  const total = w * h
  let bgPx = 0
  let lumSum = 0
  let lumSqSum = 0
  const buckets = new Set<number>()
  for (let i = 0; i < total; i++) {
    const off = i * 4
    const r = png.data[off]!
    const g = png.data[off + 1]!
    const b = png.data[off + 2]!
    if (
      Math.abs(r - BG.r) <= BG_TOL &&
      Math.abs(g - BG.g) <= BG_TOL &&
      Math.abs(b - BG.b) <= BG_TOL
    )
      bgPx++
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    lumSum += lum
    lumSqSum += lum * lum
    buckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4))
  }
  const mean = lumSum / total
  const variance = lumSqSum / total - mean * mean
  const luminanceStd = Math.sqrt(Math.max(0, variance))
  const bgFraction = bgPx / total
  const nonBgPx = total - bgPx
  // Heuristic: visibly rendered if bgFraction < 0.97 AND
  // luminanceStd > 3 (some colour variation present).
  const looksRendered = bgFraction < 0.97 && luminanceStd > 3
  return {
    width: w,
    height: h,
    totalPx: total,
    bgPx,
    bgFraction,
    nonBgPx,
    uniqueBuckets: buckets.size,
    luminanceStd,
    looksRendered,
  }
}

async function setup(page: Page, projection: string, zoom: number, pitch: number): Promise<void> {
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript(
    (args) => {
      sessionStorage.setItem('__xgisImportSource', args.src)
      sessionStorage.setItem('__xgisImportLabel', `Bright (${args.proj} z=${args.z} p=${args.p})`)
    },
    { src: xgis, proj: projection, z: zoom, p: pitch },
  )
  await page.goto(
    `/demo.html?id=__import&proj=${projection}#${zoom}/${SEOUL.lat}/${SEOUL.lon}/0/${pitch}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 60_000 },
  )
  await page.waitForTimeout(3_500)
}

const results: CellMetrics[] = []

test.describe.configure({ mode: 'serial' })

test.describe('screenshot-non-merc-seoul-matrix', () => {
  for (const proj of PROJECTIONS) {
    for (const pitch of PITCHES) {
      for (const zoom of ZOOMS) {
        test(`${proj} z=${zoom} p=${pitch}`, async ({ page }) => {
          test.setTimeout(90_000)
          await page.setViewportSize({ width: 1280, height: 800 })
          await setup(page, proj, zoom, pitch)

          const buf = await page.locator('#xg-canv, canvas').first().screenshot()
          const m = analyseScreenshot(buf)

          const cellDir = join(OUT, `${proj}-z${zoom}-p${pitch}`)
          mkdirSync(cellDir, { recursive: true })
          writeFileSync(join(cellDir, 'xgis.png'), buf)
          writeFileSync(
            join(cellDir, 'metrics.json'),
            JSON.stringify({ projection: proj, zoom, pitch, ...m }, null, 2),
          )

          const row: CellMetrics = { projection: proj, zoom, pitch, ...m }
          results.push(row)

          console.log(
            `[shot ${proj} z=${zoom} p=${pitch}] bg=${(row.bgFraction * 100).toFixed(1)}% ` +
              `buckets=${row.uniqueBuckets} lumStd=${row.luminanceStd.toFixed(1)} ` +
              (row.looksRendered ? 'RENDERED' : 'SPARSE/BLANK'),
          )
        })
      }
    }
  }

  test.afterAll(() => {
    if (results.length === 0) return
    const lines: string[] = []
    lines.push('# Non-Mercator screenshot intrinsic matrix — Seoul')
    lines.push('')
    lines.push(`Run: ${new Date().toISOString()}`)
    lines.push(`Coord: ${SEOUL.lon}, ${SEOUL.lat}; OFM bright`)
    lines.push(`Bg colour ref: rgb(${BG.r},${BG.g},${BG.b}) ±${BG_TOL}`)
    lines.push('')
    lines.push('Looks-rendered heuristic: bgFraction < 0.97 AND luminanceStd > 3.')
    lines.push('A row of zeros across the bands ⇒ render-fail / sparse-render.')
    lines.push('')
    lines.push('| Projection | Pitch | Zoom | bg% | nonBg px | uniqueBuckets | lumStd | rendered |')
    lines.push('|---|---:|---:|---:|---:|---:|---:|:--:|')
    for (const r of results) {
      lines.push(
        `| ${r.projection} | ${r.pitch}° | ${r.zoom} | ` +
          `${(r.bgFraction * 100).toFixed(1)} | ${r.nonBgPx} | ${r.uniqueBuckets} | ` +
          `${r.luminanceStd.toFixed(1)} | ${r.looksRendered ? '✓' : '✗'} |`,
      )
    }
    lines.push('')
    // Group failures explicitly.
    const failures = results.filter((r) => !r.looksRendered)
    if (failures.length > 0) {
      lines.push('## Cells flagged SPARSE/BLANK (manual inspection of xgis.png required)')
      lines.push('')
      for (const r of failures) {
        lines.push(
          `- ${r.projection} z=${r.zoom} p=${r.pitch}° — bg=${(r.bgFraction * 100).toFixed(1)}%, lumStd=${r.luminanceStd.toFixed(1)}`,
        )
      }
    } else {
      lines.push('All 6 non-Merc projections render content across the full matrix.')
    }
    writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n'))

    console.log(`[shot matrix] REPORT → ${join(OUT, 'REPORT.md')}`)
  })
})
