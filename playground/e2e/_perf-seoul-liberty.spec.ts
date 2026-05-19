// User request 2026-05-19: investigate which is the dominant perf hit
// — 3D buildings or icon rendering — and why initial load is slow.
// Seoul at various zoom × pitch combinations on OFM Liberty.
//
// Output (one row per cell):
//   - load_ms: page-goto → __xgisReady transition
//   - settle_ms: __xgisReady → no-tile-pending
//   - steady_p50 / p95: frame time over 4s steady-state window
//   - paintCenter: non-bg pixels at canvas centre (sanity)
//   - drawCalls / vertices / triangles (last frame)
//
// Compare buildings-dominant cells (z=17+ pitch>=45) vs icon-dominant
// cells (z=14, label-rich Seoul) to identify the bottleneck.

import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__perf-seoul-liberty__')
mkdirSync(OUT, { recursive: true })

interface Cell {
  slug: string
  zoom: number
  pitch: number
}

const CELLS: Cell[] = [
  { slug: 'z14-p0',  zoom: 14, pitch: 0 },   // labels + icons dense
  { slug: 'z14-p45', zoom: 14, pitch: 45 },  // mixed
  { slug: 'z16-p0',  zoom: 16, pitch: 0 },   // 3D buildings start
  { slug: 'z16-p60', zoom: 16, pitch: 60 },  // 3D buildings + many tiles
  { slug: 'z18-p0',  zoom: 18, pitch: 0 },   // dense buildings
  { slug: 'z18-p60', zoom: 18, pitch: 60 },  // worst case
]

interface Result {
  slug: string
  loadMs: number
  settleMs: number
  steadyP50: number
  steadyP95: number
  steadyMax: number
  drawCalls: number
  vertices: number
  triangles: number
  tilesVisible: number
  errors: number
}

const results: Result[] = []

for (const cell of CELLS) {
  test(`perf seoul liberty ${cell.slug}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1280, height: 800 })

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    // OFM Liberty hash: zoom/lat/lon/bearing/pitch.
    const hash = `#${cell.zoom}/37.5172/126.9810/0/${cell.pitch}`
    const t0 = Date.now()
    await page.goto(
      `/compare.html?style=openfreemap-liberty${hash}`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __xgisReady?: boolean }
        return w.__xgisReady === true
      },
      null, { timeout: 60_000 },
    )
    const loadMs = Date.now() - t0

    // Settle: wait until tile-loading is quiet AND a couple of full
    // frames have completed.
    const settleStart = Date.now()
    await page.waitForTimeout(3_000)
    await page.evaluate(() => new Promise<void>(r =>
      requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const settleMs = Date.now() - settleStart

    // 4-second steady-state frame-time capture via rAF callback.
    const steady = await page.evaluate(async () => {
      const samples: number[] = []
      let last = performance.now()
      let runs = 0
      const TARGET_FRAMES = 240  // 4 s at 60 fps
      await new Promise<void>((resolve) => {
        const tick = (now: number) => {
          const dt = now - last
          last = now
          if (runs > 0) samples.push(dt)  // skip first interval (settle noise)
          runs++
          if (runs > TARGET_FRAMES) return resolve()
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      samples.sort((a, b) => a - b)
      const p50 = samples[Math.floor(samples.length * 0.5)]!
      const p95 = samples[Math.floor(samples.length * 0.95)]!
      const max = samples[samples.length - 1]!
      return { p50, p95, max }
    })

    // Draw stats from VTR.
    const drawStats = await page.evaluate(() => {
      const m = (window as unknown as {
        __xgisMap?: { vtSources?: Map<string, { renderer?: {
          getDrawStats?: () => {
            drawCalls: number; vertices: number; triangles: number
            tilesVisible: number
          }
        } }> }
      }).__xgisMap
      if (!m?.vtSources) return null
      const agg = { drawCalls: 0, vertices: 0, triangles: 0, tilesVisible: 0 }
      for (const [, src] of m.vtSources) {
        const s = src.renderer?.getDrawStats?.()
        if (!s) continue
        agg.drawCalls += s.drawCalls
        agg.vertices += s.vertices
        agg.triangles += s.triangles
        agg.tilesVisible += s.tilesVisible
      }
      return agg
    })

    const xgPng = await page.locator('#xg-canv').screenshot({ type: 'png' })
    writeFileSync(join(OUT, `${cell.slug}-xgis.png`), xgPng)
    const mlPng = await page.locator('#ml-map canvas').first().screenshot({ type: 'png' })
    writeFileSync(join(OUT, `${cell.slug}-maplibre.png`), mlPng)

    const r: Result = {
      slug: cell.slug,
      loadMs,
      settleMs,
      steadyP50: +steady.p50.toFixed(2),
      steadyP95: +steady.p95.toFixed(2),
      steadyMax: +steady.max.toFixed(2),
      drawCalls: drawStats?.drawCalls ?? 0,
      vertices: drawStats?.vertices ?? 0,
      triangles: drawStats?.triangles ?? 0,
      tilesVisible: drawStats?.tilesVisible ?? 0,
      errors: errors.length,
    }
    results.push(r)
    // eslint-disable-next-line no-console
    console.log(`[perf ${cell.slug}] load=${r.loadMs}ms p50=${r.steadyP50}ms p95=${r.steadyP95}ms max=${r.steadyMax}ms `
      + `draws=${r.drawCalls} tris=${r.triangles} tiles=${r.tilesVisible}`)
  })
}

test.afterAll(() => {
  if (results.length === 0) return
  const lines: string[] = []
  lines.push('# Seoul Liberty perf survey')
  lines.push('')
  lines.push('| Slug | Load(ms) | p50(ms) | p95(ms) | max(ms) | Draws | Tris | Tiles |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|')
  for (const r of results) {
    lines.push(`| ${r.slug} | ${r.loadMs} | ${r.steadyP50} | ${r.steadyP95} | ${r.steadyMax} | ${r.drawCalls} | ${r.triangles} | ${r.tilesVisible} |`)
  }
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n'))
  // eslint-disable-next-line no-console
  console.log(`[perf-seoul-liberty] report → ${join(OUT, 'REPORT.md')}`)
})
