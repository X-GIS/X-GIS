// Non-Mercator deep-zoom repro harness (Seoul street level).
//
// Companion to _perf-projection-matrix.spec.ts, which sweeps zoom
// 8→12 over mid-ocean (0,35). That regime never reaches the state
// the 2026-05-19 user reports describe: every non-Mercator
// projection lags severely on zoom-in OR fails to render at
// Seoul z≈11-16 (dense urban tile data, deep zoom). See
// memory project_non_mercator_systemic_2026_05_19.
//
// Per projection this captures, at the exact reported regime:
//   1. render-success at z=11 (drawCalls/tilesVisible > 0) —
//      catches the globe / oblique "렌더링 안됨" reports.
//   2. a 13→16.5 zoom-in sweep frame-time profile — catches the
//      stereo / ortho / NE / equirect "줌 인 시 렉" reports.
//   3. tilesVisible + drawCalls at the deep end — quantifies the
//      tile explosion (iter-127 5× / globeVisibleTiles z0 descent).
//
// Mercator is the known-good control: it routes through
// visibleTilesSSE, not globeVisibleTiles, and must both render at
// z=11 and stay performant — those two facts are ASSERTED so a
// regression in the healthy path is a hard failure. The
// non-Mercator cells are informational (the systemic fix is
// tracked separately); the REPORT.md makes the pattern
// reproducible run-to-run instead of relying on ad-hoc manual
// hash pokes.

import { test, expect, type Page } from '@playwright/test'
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { runInteraction, computeStats, interactions } from './helpers/natural-interaction'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(
  resolve(__dirname, '__convert-fixtures', 'bright.json'),
  'utf8',
)
const OUT_DIR = resolve(__dirname, '__perf-projection-seoul-deep__')
mkdirSync(OUT_DIR, { recursive: true })

// Exact user-reported Seoul coordinate (lon, lat).
const SEOUL = { lon: 126.9776, lat: 37.5558 }

const PROJECTIONS = [
  'mercator', // known-good control (visibleTilesSSE path) — asserted
  'equirectangular',
  'natural_earth',
  'orthographic',
  'azimuthal_equidistant',
  'stereographic',
  'oblique_mercator',
  'globe',
] as const

interface DrawStats { drawCalls: number; tilesVisible: number; triangles: number }

interface Row {
  projection: string
  z11Rendered: boolean
  z11Tiles: number
  sweepP95: number
  sweepMax: number
  sweepMedian: number
  deepTiles: number
  deepDraws: number
}

const rows: Row[] = []

async function readDrawStats(page: Page): Promise<DrawStats> {
  return page.evaluate(() => {
    const m = (window as unknown as {
      __xgisMap?: { vtSources?: Map<string, { renderer?: {
        getDrawStats?: () => { drawCalls: number; vertices: number; triangles: number; tilesVisible: number }
      } }> }
    }).__xgisMap
    const agg = { drawCalls: 0, tilesVisible: 0, triangles: 0 }
    if (!m?.vtSources) return agg
    for (const [, src] of m.vtSources) {
      const s = src.renderer?.getDrawStats?.()
      if (!s) continue
      agg.drawCalls += s.drawCalls
      agg.tilesVisible += s.tilesVisible
      agg.triangles += s.triangles
    }
    return agg
  })
}

async function setup(page: Page, projection: string): Promise<void> {
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript((args) => {
    sessionStorage.setItem('__xgisImportSource', args.src)
    sessionStorage.setItem('__xgisImportLabel', `Bright (proj=${args.proj})`)
  }, { src: xgis, proj: projection })
  // Start at z=11 Seoul — the exact "not rendering" report regime.
  await page.goto(
    `/demo.html?id=__import&proj=${projection}#11/${SEOUL.lat}/${SEOUL.lon}/0/0`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(3_000) // tile cascade settle
}

test.describe.configure({ mode: 'serial' })

test.describe('perf-projection-seoul-deep', () => {
  for (const proj of PROJECTIONS) {
    test(`${proj} — z11 render + 13→16.5 zoom-in`, async ({ page }) => {
      test.setTimeout(120_000)
      await setup(page, proj)

      // (1) Render-success at z=11.
      const z11 = await readDrawStats(page)
      const z11Rendered = z11.drawCalls > 0 && z11.tilesVisible > 0

      // (2) Deep zoom-in sweep 13 → 16.5.
      const timings = await runInteraction(
        page, interactions.zoom(13, 16.5), { durationMs: 5000 },
      )
      const stats = computeStats(timings)
      await page.waitForTimeout(500)
      const deep = await readDrawStats(page)

      rows.push({
        projection: proj,
        z11Rendered,
        z11Tiles: z11.tilesVisible,
        sweepP95: +stats.p95.toFixed(1),
        sweepMax: +stats.max.toFixed(1),
        sweepMedian: +stats.median.toFixed(1),
        deepTiles: deep.tilesVisible,
        deepDraws: deep.drawCalls,
      })

      // eslint-disable-next-line no-console
      console.log(
        `[seoul-deep ${proj}] z11Rendered=${z11Rendered} z11Tiles=${z11.tilesVisible} `
        + `sweep p95=${stats.p95.toFixed(1)} max=${stats.max.toFixed(1)} `
        + `deepTiles=${deep.tilesVisible} deepDraws=${deep.drawCalls}`,
      )

      // Mercator is the known-good control — it must render at z=11
      // and not stall (it does not route through globeVisibleTiles).
      // A regression in the healthy path is a hard failure; the
      // non-Mercator systemic issue is tracked separately so those
      // cells stay informational.
      if (proj === 'mercator') {
        expect(z11Rendered, 'mercator must render at z=11 Seoul').toBe(true)
        expect(stats.max, 'mercator zoom-in must not hard-stall').toBeLessThan(2_000)
      }
    })
  }

  test.afterAll(() => {
    const lines = [
      '# Non-Mercator deep-zoom repro — Seoul street level',
      '',
      `Run: ${new Date().toISOString()}`,
      `Coord: ${SEOUL.lon}, ${SEOUL.lat} (OFM bright)`,
      '',
      'z11Rendered=false → "렌더링 안됨" report reproduced.',
      'High sweepP95/Max + large deepTiles → "줌 인 시 렉" reproduced.',
      'Compare every row against the mercator control.',
      '',
      '| Projection | z11 rendered | z11 tiles | sweep median | sweep p95 | sweep max | deep tiles | deep draws |',
      '|---|:--:|--:|--:|--:|--:|--:|--:|',
    ]
    for (const r of rows) {
      lines.push(
        `| ${r.projection} | ${r.z11Rendered ? '✓' : '✗'} | ${r.z11Tiles} `
        + `| ${r.sweepMedian} | ${r.sweepP95} | ${r.sweepMax} `
        + `| ${r.deepTiles} | ${r.deepDraws} |`,
      )
    }
    writeFileSync(join(OUT_DIR, 'REPORT.md'), lines.join('\n'))
    // eslint-disable-next-line no-console
    console.log(`[seoul-deep] report → ${join(OUT_DIR, 'REPORT.md')}`)
  })
})
