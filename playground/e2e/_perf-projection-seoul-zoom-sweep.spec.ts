// Perf matrix: every X-GIS projection × pitch × Seoul zoom-sweep 0→19.
//
// User request 2026-05-20: 모든 projection 에서 서울 중심으로 zoom 0→19
// 줌인을 여러 피치에서. Companion to _perf-projection-seoul-deep
// (fixed-camera deep-zoom) and _perf-merc-high-pitch-drag (pan).
// This one drives a continuous rAF zoom sweep at each (proj, pitch)
// cell and records the cumulative perf signature.
//
// Output:
//   - test-results/<not> — this is informational only, no
//     mandatory assertion (mercator-only control + sanity);
//   - __perf-projection-seoul-zoom-sweep__/REPORT.md with the
//     full matrix in markdown.
//
// 8 proj × 3 pitch = 24 cells × ~12 s each ≈ 5 min total.

import { test, type Page, expect } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { runInteraction, computeStats, interactions } from './helpers/natural-interaction'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(__dirname, '__convert-fixtures', 'bright.json'), 'utf8')
const OUT_DIR = resolve(__dirname, '__perf-projection-seoul-zoom-sweep__')
mkdirSync(OUT_DIR, { recursive: true })

const SEOUL = { lon: 126.9776, lat: 37.5558 }
const PROJECTIONS = [
  'mercator',
  'equirectangular',
  'natural_earth',
  'orthographic',
  'azimuthal_equidistant',
  'stereographic',
  'oblique_mercator',
  'globe',
] as const
const PITCHES = [0, 30, 60] as const

interface DrawStats {
  drawCalls: number
  tilesVisible: number
  triangles: number
  lines: number
}

interface CellResult {
  projection: string
  pitch: number
  startZ: number
  endZ: number
  durationMs: number
  framesObserved: number
  median: number
  p95: number
  p99: number
  max: number
  finalTiles: number
  finalDraws: number
  finalTris: number
}

const results: CellResult[] = []

async function readStats(page: Page): Promise<DrawStats> {
  return page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: {
          vtSources?: Map<
            string,
            {
              renderer?: {
                getDrawStats?: () => DrawStats
              }
            }
          >
        }
      }
    ).__xgisMap
    const agg = { drawCalls: 0, tilesVisible: 0, triangles: 0, lines: 0 }
    if (!m?.vtSources) return agg
    for (const [, src] of m.vtSources) {
      const s = src.renderer?.getDrawStats?.()
      if (!s) continue
      agg.drawCalls += s.drawCalls
      agg.tilesVisible += s.tilesVisible
      agg.triangles += s.triangles
      agg.lines += s.lines ?? 0
    }
    return agg
  }) as Promise<DrawStats>
}

async function setup(page: Page, projection: string, pitch: number): Promise<void> {
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript(
    (args) => {
      sessionStorage.setItem('__xgisImportSource', args.src)
      sessionStorage.setItem('__xgisImportLabel', `Bright (proj=${args.proj} pitch=${args.pitch})`)
    },
    { src: xgis, proj: projection, pitch },
  )
  // Start at z=0 with the requested pitch + bearing 0.
  await page.goto(
    `/demo.html?id=__import&proj=${projection}#0/${SEOUL.lat}/${SEOUL.lon}/0/${pitch}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 60_000 },
  )
  await page.waitForTimeout(3_500) // initial cascade
}

test.describe.configure({ mode: 'serial' })

test.describe('perf-projection-seoul-zoom-sweep', () => {
  for (const proj of PROJECTIONS) {
    for (const pitch of PITCHES) {
      test(`${proj} pitch=${pitch} zoom 0→19`, async ({ page }) => {
        test.setTimeout(120_000)
        await setup(page, proj, pitch)

        const DUR_MS = 8000
        const timings = await runInteraction(page, interactions.zoom(0, 19), { durationMs: DUR_MS })
        const stats = computeStats(timings)
        await page.waitForTimeout(500)
        const finalStats = await readStats(page)

        const r: CellResult = {
          projection: proj,
          pitch,
          startZ: 0,
          endZ: 19,
          durationMs: DUR_MS,
          framesObserved: timings.frames.length,
          median: +stats.median.toFixed(1),
          p95: +stats.p95.toFixed(1),
          p99: +stats.p99.toFixed(1),
          max: +stats.max.toFixed(1),
          finalTiles: finalStats.tilesVisible,
          finalDraws: finalStats.drawCalls,
          finalTris: finalStats.triangles,
        }
        results.push(r)

        console.log(
          `[sweep ${proj} p=${pitch}] frames=${r.framesObserved} ` +
            `median=${r.median} p95=${r.p95} p99=${r.p99} max=${r.max}ms ` +
            `finalTiles=${r.finalTiles} finalDraws=${r.finalDraws} finalTris=${r.finalTris}`,
        )

        // Sanity: mercator pitch=0 is the known-healthy control —
        // it must complete the sweep without a multi-second stall.
        if (proj === 'mercator' && pitch === 0) {
          expect(r.max, 'mercator pitch=0 sweep must not hard-stall').toBeLessThan(4000)
        }
      })
    }
  }

  test.afterAll(() => {
    if (results.length === 0) return
    const lines: string[] = []
    lines.push('# Perf matrix — Seoul zoom 0→19 sweep × 8 proj × 3 pitch')
    lines.push('')
    lines.push(`Run: ${new Date().toISOString()}`)
    lines.push(`Seoul: ${SEOUL.lon}, ${SEOUL.lat}; OFM bright; 8 s rAF zoom sweep per cell`)
    lines.push('')
    lines.push(
      '| Projection | Pitch | Frames | Median | p95 | p99 | Max | TilesEnd | DrawsEnd | TrisEnd |',
    )
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const r of results) {
      lines.push(
        `| ${r.projection} | ${r.pitch}° | ${r.framesObserved} | ${r.median} | ${r.p95} | ${r.p99} | ${r.max} | ` +
          `${r.finalTiles} | ${r.finalDraws} | ${r.finalTris} |`,
      )
    }
    lines.push('')
    lines.push('## Interpretation guide')
    lines.push('- mercator pitch=0 = control; healthy reference for the row.')
    lines.push('- p95 > 50 ms → drag/zoom-time jank; max ≫ 200 ms → hard stalls.')
    lines.push('- Final-state TilesEnd ≈ TilesEnd at z=19 sustained; high values for')
    lines.push('  globe/oblique are the documented post-iter-149 over-select (renders correctly).')
    writeFileSync(join(OUT_DIR, 'REPORT.md'), lines.join('\n'))

    console.log(`[sweep] REPORT → ${join(OUT_DIR, 'REPORT.md')}`)
  })
})
