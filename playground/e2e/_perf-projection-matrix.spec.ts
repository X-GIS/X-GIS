// Projection × interaction perf matrix.
//
// Eight projections (mercator, equirect, natural_earth, ortho,
// azimuthal_equidistant, stereographic, oblique_mercator, globe) × four
// natural-interaction scenarios (pan, zoom, rotate, pitch) = 32 cells.
// Each cell drives a ~6 second rAF-paced sequence and records per-frame
// frame times via the natural-interaction helper.
//
// Gate thresholds (initial — calibrate from local GPU baseline):
//   p95   < 50 ms   (≈ 20 fps worst-case for 95% of frames)
//   max   < 200 ms  (no frame-long stall)
//
// Phase 8.2 of the X-GIS strict-spec / runtime parity plan. The full
// gate enabling depends on local GPU + a self-hosted runner; until
// then this spec emits a non-blocking REPORT.md for inspection.

import { test, type Page } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
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

const OUT_DIR = resolve(__dirname, '__perf-projection-matrix__')
mkdirSync(OUT_DIR, { recursive: true })

interface CellResult {
  projection: string
  scenario: string
  median: number
  p95: number
  p99: number
  max: number
  count: number
}

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

const SCENARIOS: { name: string; body: () => (mapId: string, t: number) => void }[] = [
  { name: 'pan',    body: () => interactions.pan({ lng: -10, lat: 35 }, { lng: 10, lat: 35 }) },
  { name: 'zoom',   body: () => interactions.zoom(8, 12) },
  { name: 'rotate', body: () => interactions.rotate(0, 90) },
  { name: 'pitch',  body: () => interactions.pitch(0, 60) },
]

async function setupPage(page: Page, projection: string) {
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript((args) => {
    sessionStorage.setItem('__xgisImportSource', args.src)
    sessionStorage.setItem('__xgisImportLabel', `Bright (proj=${args.proj})`)
  }, { src: xgis, proj: projection })
  await page.goto(
    `/demo.html?id=__import&proj=${projection}#8/35/0/0/0`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // Initial cascade settle
  await page.waitForTimeout(2_000)
}

test.describe.configure({ mode: 'serial' })

test.describe('perf-projection-matrix', () => {
  const results: CellResult[] = []

  for (const proj of PROJECTIONS) {
    for (const scenario of SCENARIOS) {
      test(`${proj} × ${scenario.name}`, async ({ page }) => {
        await setupPage(page, proj)
        const body = scenario.body()
        const timings = await runInteraction(page, body, { durationMs: 5000 })
        const stats = computeStats(timings)
        results.push({
          projection: proj,
          scenario: scenario.name,
          ...stats,
        })
        // Informational only — log to console for trace inspection.
        // Real gate enabling needs local GPU baseline calibration.
        console.log(`[perf-matrix] ${proj} × ${scenario.name}: p95=${stats.p95.toFixed(1)}ms p99=${stats.p99.toFixed(1)}ms max=${stats.max.toFixed(1)}ms n=${stats.count}`)
      })
    }
  }

  test.afterAll(() => {
    // Emit a summary REPORT.md for inspection
    const lines = [
      '# Projection × Interaction Perf Matrix',
      '',
      `Run: ${new Date().toISOString()}`,
      '',
      '| Projection | Scenario | median (ms) | p95 (ms) | p99 (ms) | max (ms) | frames |',
      '|---|---|---:|---:|---:|---:|---:|',
    ]
    for (const r of results) {
      lines.push(`| ${r.projection} | ${r.scenario} | ${r.median.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.p99.toFixed(1)} | ${r.max.toFixed(1)} | ${r.count} |`)
    }
    writeFileSync(join(OUT_DIR, 'REPORT.md'), lines.join('\n'))
  })
})
