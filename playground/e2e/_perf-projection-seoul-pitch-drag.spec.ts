// Real-user interaction perf: pitch-lower then drag-pan.
//
// User request 2026-05-20: 좀더 올바른 계측을 위해 피치를 낮춘 후 지도
// 드래그를 좀 진행. Mirrors a realistic gesture — user looks across
// the terrain (pitch up), then lowers + pans to scan. The earlier
// _perf-projection-seoul-zoom-sweep covered continuous zoom; this
// covers the OTHER common interaction pattern.
//
// Per cell (8 proj × 2 startPitch {45, 60} = 16 cells, ~5 min):
//   Phase A: pitch ramp startPitch → 0 (3 s rAF)
//   Phase B: drag-pan ~200 m at the current view (4 s rAF)
//   Phases recorded SEPARATELY so the pitch-cost and pan-cost
//   contributions stay distinguishable in the matrix.
//
// Zoom held at 14 (urban scene complexity sweet-spot — z<12 too
// sparse to stress text/labels; z>16 dominated by tile loading).
//
// Output: REPORT.md with two phase blocks per cell.

import { test, type Page, expect } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { runInteraction, computeStats, interactions } from './helpers/natural-interaction'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(__dirname, '__convert-fixtures', 'bright.json'), 'utf8')
const OUT_DIR = resolve(__dirname, '__perf-projection-seoul-pitch-drag__')
mkdirSync(OUT_DIR, { recursive: true })

const SEOUL = { lon: 126.9776, lat: 37.5558 }
const ZOOM = 14
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
const START_PITCHES = [45, 60] as const

interface PhaseStats {
  frames: number
  median: number
  p95: number
  p99: number
  max: number
}

interface CellResult {
  projection: string
  startPitch: number
  pitchPhase: PhaseStats
  dragPhase: PhaseStats
  finalTiles: number
  finalDraws: number
  finalTris: number
}

interface DrawStats {
  drawCalls: number
  tilesVisible: number
  triangles: number
  lines: number
}

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

async function setup(page: Page, projection: string, startPitch: number): Promise<void> {
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript(
    (args) => {
      sessionStorage.setItem('__xgisImportSource', args.src)
      sessionStorage.setItem('__xgisImportLabel', `Bright (${args.proj} startPitch=${args.p})`)
    },
    { src: xgis, proj: projection, p: startPitch },
  )
  // Start at z=14 Seoul with the configured starting pitch.
  await page.goto(
    `/demo.html?id=__import&proj=${projection}#${ZOOM}/${SEOUL.lat}/${SEOUL.lon}/0/${startPitch}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 60_000 },
  )
  await page.waitForTimeout(3_500)
}

function toPhaseStats(timings: { frames: number[]; totalMs: number }): PhaseStats {
  const s = computeStats(timings)
  return {
    frames: timings.frames.length,
    median: +s.median.toFixed(1),
    p95: +s.p95.toFixed(1),
    p99: +s.p99.toFixed(1),
    max: +s.max.toFixed(1),
  }
}

const results: CellResult[] = []

test.describe.configure({ mode: 'serial' })

test.describe('perf-projection-seoul-pitch-drag', () => {
  for (const proj of PROJECTIONS) {
    for (const startPitch of START_PITCHES) {
      test(`${proj} startPitch=${startPitch} → 0 + drag`, async ({ page }) => {
        test.setTimeout(120_000)
        await setup(page, proj, startPitch)

        // Phase A: pitch ramp startPitch → 0.
        const pitchTimings = await runInteraction(page, interactions.pitch(startPitch, 0), {
          durationMs: 3000,
        })
        await page.waitForTimeout(300) // mini-settle between phases

        // Phase B: drag-pan ~200 m at the now-flat view.
        const dragTimings = await runInteraction(
          page,
          interactions.pan(
            { lng: SEOUL.lon, lat: SEOUL.lat },
            { lng: SEOUL.lon + 0.002, lat: SEOUL.lat + 0.001 },
          ),
          { durationMs: 4000 },
        )
        await page.waitForTimeout(500)
        const finalStats = await readStats(page)

        const r: CellResult = {
          projection: proj,
          startPitch,
          pitchPhase: toPhaseStats(pitchTimings),
          dragPhase: toPhaseStats(dragTimings),
          finalTiles: finalStats.tilesVisible,
          finalDraws: finalStats.drawCalls,
          finalTris: finalStats.triangles,
        }
        results.push(r)

        console.log(
          `[pd ${proj} sp=${startPitch}] ` +
            `pitch:p95=${r.pitchPhase.p95}/max=${r.pitchPhase.max} ` +
            `drag:p95=${r.dragPhase.p95}/max=${r.dragPhase.max} ` +
            `tiles=${r.finalTiles} tris=${r.finalTris}`,
        )

        // Sanity: mercator (known-healthy control) must complete both
        // phases without a multi-second stall.
        if (proj === 'mercator') {
          expect(r.pitchPhase.max, 'mercator pitch-ramp must not hard-stall').toBeLessThan(2000)
          expect(r.dragPhase.max, 'mercator drag must not hard-stall').toBeLessThan(2000)
        }
      })
    }
  }

  test.afterAll(() => {
    if (results.length === 0) return
    const lines: string[] = []
    lines.push('# Perf matrix — Seoul pitch-down + drag-pan (z=14)')
    lines.push('')
    lines.push(`Run: ${new Date().toISOString()}`)
    lines.push(`Coord: ${SEOUL.lon}, ${SEOUL.lat}; OFM bright; z=${ZOOM}`)
    lines.push('Phase A = pitch ramp startPitch → 0 (3 s rAF).')
    lines.push('Phase B = drag-pan ~200 m at the flat view (4 s rAF).')
    lines.push('')
    lines.push('## Phase A — pitch ramp')
    lines.push('')
    lines.push('| Projection | StartPitch | Frames | Median | p95 | p99 | Max |')
    lines.push('|---|---:|---:|---:|---:|---:|---:|')
    for (const r of results) {
      lines.push(
        `| ${r.projection} | ${r.startPitch}° | ${r.pitchPhase.frames} | ` +
          `${r.pitchPhase.median} | ${r.pitchPhase.p95} | ${r.pitchPhase.p99} | ` +
          `${r.pitchPhase.max} |`,
      )
    }
    lines.push('')
    lines.push('## Phase B — drag-pan')
    lines.push('')
    lines.push(
      '| Projection | StartPitch | Frames | Median | p95 | p99 | Max | TilesEnd | DrawsEnd | TrisEnd |',
    )
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const r of results) {
      lines.push(
        `| ${r.projection} | ${r.startPitch}° | ${r.dragPhase.frames} | ` +
          `${r.dragPhase.median} | ${r.dragPhase.p95} | ${r.dragPhase.p99} | ` +
          `${r.dragPhase.max} | ${r.finalTiles} | ${r.finalDraws} | ${r.finalTris} |`,
      )
    }
    lines.push('')
    lines.push('## Interpretation')
    lines.push('- p95 < 50 ms = ≥ 20 fps for 95% of frames → acceptable.')
    lines.push('- max ≫ 200 ms = visible stall.')
    lines.push('- Phase A vs Phase B p95 delta = pitch-ramp cost vs steady-state pan cost.')
    lines.push('- Same projection / different startPitch comparison shows whether')
    lines.push('  the ramp itself costs more (transient tile-set churn) than the pan')
    lines.push('  at the destination pitch.')
    writeFileSync(join(OUT_DIR, 'REPORT.md'), lines.join('\n'))

    console.log(`[pd] REPORT → ${join(OUT_DIR, 'REPORT.md')}`)
  })
})
