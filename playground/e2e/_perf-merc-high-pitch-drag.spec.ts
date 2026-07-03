// Mercator high-pitch drag-pan repro (user report #10, 2026-05-19).
//
// User: 'import "https://tiles.openfreemap.org/styles/liberty"
// #17.30/37.53772/126.97760/285.0/68.1  지도 드래그 이동시
// 엄청난 렉이 발생함' — Liberty (mercator default) at Seoul z17
// pitch68 bearing285, drag-pan stutters severely.
//
// This spec captures static-frame stats at the exact user camera
// AND a 5-second rAF pan drag sweep at the same state. Mirrors
// _perf-high-pitch-manhattan (osm_style Manhattan z16 pitch77 —
// related but DIFFERENT regime: that was static-frame GPU-bound;
// THIS is drag-time CPU/upload churn).
//
// Numbers only — diagnose root from the table, no patch this
// iteration. memory: project_high_pitch_thermal_2026_05_11 +
// project_tile_pitch_matrix (don't blind-patch this class).

import { test, type Page } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { runInteraction, computeStats, interactions } from './helpers/natural-interaction'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(__dirname, '__convert-fixtures', 'liberty.json'), 'utf8')
const OUT = resolve(__dirname, '__perf-merc-high-pitch-drag__')
mkdirSync(OUT, { recursive: true })

const SEOUL = { lon: 126.9776, lat: 37.53772 }
// EXACT user hash: zoom 17.30, pitch 68.1, bearing 285.0
const HASH = `#17.30/${SEOUL.lat}/${SEOUL.lon}/285.0/68.1`

interface DrawStats {
  drawCalls: number
  tilesVisible: number
  triangles: number
  lines: number
  missedTiles: number
  globeTilesSelected: number
}

async function setup(page: Page): Promise<void> {
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript((src) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'Liberty')
  }, xgis)
  await page.goto(`/demo.html?id=__import${HASH}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(4_000) // cascade + extrude settle
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
    const agg = {
      drawCalls: 0,
      tilesVisible: 0,
      triangles: 0,
      lines: 0,
      missedTiles: 0,
      globeTilesSelected: 0,
    }
    if (!m?.vtSources) return agg
    for (const [, src] of m.vtSources) {
      const s = src.renderer?.getDrawStats?.()
      if (!s) continue
      agg.drawCalls += s.drawCalls
      agg.tilesVisible += s.tilesVisible
      agg.triangles += s.triangles
      agg.lines += (s as { lines?: number }).lines ?? 0
      agg.missedTiles += s.missedTiles
    }
    return agg
  }) as Promise<DrawStats>
}

test('merc high-pitch drag — Liberty Seoul z17 pitch68', async ({ page }) => {
  test.setTimeout(120_000)
  await setup(page)

  // Static-frame stats at the exact user camera.
  const staticStats = await readStats(page)

  // 5 s drag-pan sweep — small lon delta, no zoom change. interactions.pan
  // calls XGISMap.setCenter every rAF; mirrors a user-finger drag.
  const panTimings = await runInteraction(
    page,
    interactions.pan(
      { lng: SEOUL.lon, lat: SEOUL.lat },
      { lng: SEOUL.lon + 0.002, lat: SEOUL.lat + 0.001 }, // small drag (~200m)
    ),
    { durationMs: 5000 },
  )
  const panStats = computeStats(panTimings)
  await page.waitForTimeout(500)
  const postPanStats = await readStats(page)

  const lines = [
    '# Liberty Seoul z17 pitch68 drag-pan repro (user #10)',
    '',
    `Run: ${new Date().toISOString()}`,
    `Hash: ${HASH}`,
    '',
    '## Static-frame stats (no movement, post-settle)',
    '',
    `tilesVisible=${staticStats.tilesVisible}  drawCalls=${staticStats.drawCalls}  triangles=${staticStats.triangles}  lines=${staticStats.lines}  missedTiles=${staticStats.missedTiles}`,
    '',
    '## Pan-drag 5s rAF sweep',
    '',
    `frames=${panStats.count}  median=${panStats.median.toFixed(1)}ms  p95=${panStats.p95.toFixed(1)}ms  p99=${panStats.p99.toFixed(1)}ms  max=${panStats.max.toFixed(1)}ms`,
    `post-pan tilesVisible=${postPanStats.tilesVisible}  drawCalls=${postPanStats.drawCalls}  triangles=${postPanStats.triangles}`,
    '',
    '## Diagnosis hooks',
    '- p95 ≫ 50 ms or max ≫ 200 ms → confirms drag-time jank',
    '- tilesVisible spike during drag vs static → tile-budget churn',
    '- triangles ≫ 1 M → likely Liberty 3D building density at z17',
    '- missedTiles > 0 → upload backlog (decode/upload bottleneck)',
  ]
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n'))
  // eslint-disable-next-line no-console
  console.log(
    `[merc-high-pitch-drag] static: tiles=${staticStats.tilesVisible} draws=${staticStats.drawCalls} tris=${staticStats.triangles}` +
      ` | pan: p95=${panStats.p95.toFixed(1)} max=${panStats.max.toFixed(1)} post-tiles=${postPanStats.tilesVisible}`,
  )
})
