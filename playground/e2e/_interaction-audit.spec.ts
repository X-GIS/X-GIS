// Realistic fixture interaction: load each fixture, drive zoom + pan +
// pitch/bearing changes that a real user would do, then count sustained
// FLICKER bursts and other warnings. Distinct from the 57-fixture audit
// because this tests DIFFICULT camera poses (pitch, bearing, deep zoom)
// rather than a fixed baseline.

import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__interaction-audit__')
mkdirSync(ART, { recursive: true })

const FIXTURES = [
  'fixture_anim_dashoffset',   // User-reported: z=5.72 pitch=6.4 on iOS
  'fixture_line',
  'fixture_line_join',
  'fixture_anim_opacity',
  'fixture_stress_many_layers',
  'fixture_pattern_lines' in {} ? 'pattern_lines' : 'pattern_lines',
  'fixture_translucent_stroke',
  'fixture_typed_array_points',
]

interface InteractionResult {
  id: string
  frames: number
  maxDt: number
  p95Dt: number
  flickerEvents: number
  sustainedFlickerFrames: number
  maxMissedTiles: number
  consoleErrors: string[]
  consoleWarns: string[]
}

test('interaction audit — pitch, bearing, deep zoom', async ({ page }) => {
  test.setTimeout(600_000)
  await page.setViewportSize({ width: 1200, height: 700 })

  const results: InteractionResult[] = []

  for (const id of FIXTURES) {
    const errors: string[] = []
    const warns: string[] = []
    const flickers: string[] = []
    const onConsole = (m: import('@playwright/test').ConsoleMessage): void => {
      const t = m.text()
      if (t.includes('[FLICKER]')) flickers.push(t)
      if (/\[vite\]|powerPreference|Failed to load resource/.test(t)) return
      if (m.type() === 'error') errors.push(t)
      else if (m.type() === 'warning' && !t.includes('[FLICKER]')) warns.push(t)
    }
    page.on('console', onConsole)

    await page.goto(`/demo.html?id=${id}&e2e=1`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 15_000 },
    )
    await page.waitForTimeout(800)

    // Mirror the user's iOS interaction: sharp zoom with bearing +
    // pitch changes. Every 50 ms take a frame sample + count
    // missedTiles across all sources to detect sustained FLICKER
    // (vs single-frame bursts).
    const telemetry = await page.evaluate(() => new Promise<{
      samples: { t: number; dt: number; missed: number }[]
      maxMissed: number
      sustainedMissed: number
    }>((resolve) => {
      const R = 6378137
      const win = window as unknown as {
        __xgisMap: {
          camera: { centerX: number; centerY: number; zoom: number; bearing: number; pitch: number }
          vtSources?: Map<string, { renderer: { getDrawStats(): { missedTiles: number } } }>
        }
      }
      const map = win.__xgisMap
      const samples: { t: number; dt: number; missed: number }[] = []
      const t0 = performance.now()
      let lastT = t0
      let maxMissed = 0
      let sustainedMissed = 0
      let consecMissed = 0

      function phase(u: number): void {
        // Real-user gesture: zoom + pan for 2 s, then STOP and let tiles
        // catch up for 3 s. The user-reported FLICKER on iPhone was at a
        // static camera (no movement), so the sustained-miss measurement
        // must include a rest period.
        if (u < 0.2) {
          map.camera.zoom = (u / 0.2) * 5.72
        } else if (u < 0.3) {
          const pu = (u - 0.2) / 0.1
          map.camera.pitch = pu * 6.4
          map.camera.bearing = 354.1
        } else if (u < 0.4) {
          // Brief pan to simulate user flicking before landing on target
          const pu = (u - 0.3) / 0.1
          map.camera.centerX = pu * 1 * Math.PI / 180 * R
        }
        // u >= 0.4: camera frozen at the user-reported pose for the
        // remaining 3 s — the window where FLICKER should disappear.
      }

      const TOTAL_MS = 5000
      function tick() {
        const tNow = performance.now()
        const tRel = tNow - t0
        const dt = tNow - lastT
        let missed = 0
        if (map.vtSources) {
          for (const [, { renderer }] of map.vtSources) {
            missed += renderer.getDrawStats().missedTiles
          }
        }
        samples.push({ t: tRel, dt, missed })
        lastT = tNow
        if (missed > maxMissed) maxMissed = missed
        if (missed > 0) { consecMissed++; sustainedMissed = Math.max(sustainedMissed, consecMissed) }
        else consecMissed = 0

        phase(tRel / TOTAL_MS)
        if (tRel >= TOTAL_MS) resolve({ samples, maxMissed, sustainedMissed })
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }))

    const fs = telemetry.samples.slice(2)
    const dts = fs.map(s => s.dt).sort((a, b) => a - b)
    const pct = (p: number) => dts[Math.floor(dts.length * p)] ?? 0

    // Split the samples into the "moving" window (first 40% of the test)
    // vs the "rest" window (remaining 60% where the camera is static).
    // The rest-window missedTiles is the one that actually matters — if
    // it's non-zero, tiles are stuck.
    const moveEnd = Math.floor(fs.length * 0.4)
    const restSamples = fs.slice(moveEnd)
    const restMissed = restSamples.filter(s => s.missed > 0).length
    const restMissedPeak = Math.max(0, ...restSamples.map(s => s.missed))

    results.push({
      id,
      frames: fs.length,
      maxDt: +dts[dts.length - 1]?.toFixed(1),
      p95Dt: +pct(0.95).toFixed(1),
      flickerEvents: flickers.length,
      sustainedFlickerFrames: telemetry.sustainedMissed,
      maxMissedTiles: telemetry.maxMissed,
      restMissedFrames: restMissed,
      restMissedPeak,
      consoleErrors: errors,
      consoleWarns: warns,
    } as InteractionResult & { restMissedFrames: number; restMissedPeak: number })

    page.off('console', onConsole)
  }

  // Report
  console.log('\n=== INTERACTION AUDIT ===')
  for (const r of results) {
    const extra = r as InteractionResult & { restMissedFrames: number; restMissedPeak: number }
    const status = r.consoleErrors.length > 0 ? '✗' :
      extra.restMissedFrames > 30 ? '⚠' : '✓'
    console.log(`${status} ${r.id.padEnd(36)} p95=${r.p95Dt}ms max=${r.maxDt}ms moveMissed=${r.maxMissedTiles} REST=${extra.restMissedFrames}frames/peak=${extra.restMissedPeak} flickerEv=${r.flickerEvents} errors=${r.consoleErrors.length}`)
    for (const e of r.consoleErrors.slice(0, 3)) console.log(`    [error] ${e.slice(0, 160)}`)
  }
  writeFileSync(join(ART, 'report.json'), JSON.stringify(results, null, 2))
})
