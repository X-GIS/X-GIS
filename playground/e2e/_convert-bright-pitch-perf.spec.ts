// Pitch-perf reproduction for the OpenFreeMap bright style.
//
// User report: rendering is fine at flat pitch but "extremely slow"
// when pitch is lowered (camera tilts). Two suspect bottlenecks:
//   (a) tile-selection budget grows 2-4× under pitch; per-tile MVT
//       decode + 81-show filter evaluation in the worker pool may
//       saturate.
//   (b) MAX_UPLOADS_PER_FRAME = 4 is fixed/count-only (no time
//       budget). At high pitch with 240+ visible tiles, convergence
//       takes 60+ frames; during camera motion the cache thrashes.
//
// This spec measures actual frame time + tile-state at 4 pitches so
// we can see where the cliff lives and target the right fix.

import { test, expect } from '@playwright/test'
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(__dirname, '__convert-fixtures/bright.json'), 'utf8')

const PITCHES = [0, 40, 60, 80]

test('bright style: frame-time profile across pitches at z=14 Tokyo', async ({ page }) => {
  test.setTimeout(180_000)

  const xgis = convertMapboxStyle(fixture)

  await page.addInitScript((src: string) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'Bright (OpenFreeMap)')
  }, xgis)

  const results: { pitch: number; medianFrameMs: number; p95FrameMs: number; sampledFrames: number; tilesAtEnd: number; uploadsAtEnd: number; drawCallsAtEnd: number }[] = []

  for (const pitch of PITCHES) {
    // Hash format from camera.ts: zoom/lat/lon/bearing/pitch
    await page.goto(`/demo.html?id=__import#14/35.68/139.76/0/${pitch}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 },
    )
    // Let initial tiles converge before measuring.
    await page.waitForTimeout(5_000)

    // Sample frame times via rAF for 3 seconds. Continuous rAF runs
    // only when something invalidates the renderer; the playground
    // explicitly invalidates per-frame to keep animations alive (and
    // for our purposes, sampling steady-state).
    const sample = await page.evaluate(async () => {
      return await new Promise<{ frames: number[]; pipeline: unknown }>((res) => {
        const frames: number[] = []
        let last = performance.now()
        const start = last
        const tick = () => {
          const now = performance.now()
          frames.push(now - last)
          last = now
          if (now - start < 3000) requestAnimationFrame(tick)
          else {
            const map = (window as unknown as { __xgisMap?: { inspectPipeline?: () => unknown } }).__xgisMap
            const pipeline = map?.inspectPipeline ? map.inspectPipeline() : null
            res({ frames, pipeline })
          }
        }
        requestAnimationFrame(tick)
      })
    })

    const sorted = [...sample.frames].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const p95 = sorted[Math.floor(sorted.length * 0.95)]
    const pipeline = sample.pipeline as { sources?: Array<{ name: string; cache: { gpuLayers: number; pendingUploads: number; subTileBudgetUsed: number; compileBudgetUsed: number; hasData: boolean }; frame: { drawCalls: number; tilesVisible: number; missedTiles: number; triangles: number; lines: number } }> } | null
    const sourceFrame = pipeline?.sources?.[0]?.frame
    const sourceCache = pipeline?.sources?.[0]?.cache
    results.push({
      pitch,
      medianFrameMs: median,
      p95FrameMs: p95,
      sampledFrames: sample.frames.length,
      tilesAtEnd: sourceFrame?.tilesVisible ?? -1,
      uploadsAtEnd: sourceCache?.pendingUploads ?? -1,
      drawCallsAtEnd: sourceFrame?.drawCalls ?? -1,
    })
    // eslint-disable-next-line no-console
    console.log(`pitch=${pitch}: pipeline =`, JSON.stringify(pipeline?.sources?.[0]))
    await page.locator('#map').screenshot({ path: `test-results/bright-pitch-${pitch}.png` })
  }

  // eslint-disable-next-line no-console
  console.log('\n=== bright pitch perf ===')
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(
      `  pitch=${r.pitch.toString().padStart(2)}°: ` +
      `median=${r.medianFrameMs.toFixed(1)}ms (${(1000 / r.medianFrameMs).toFixed(0)} fps) ` +
      `p95=${r.p95FrameMs.toFixed(1)}ms ` +
      `frames=${r.sampledFrames} ` +
      `tiles=${r.tilesAtEnd} uploads=${r.uploadsAtEnd} drawCalls=${r.drawCallsAtEnd}`,
    )
  }

  // Pitch=60° was the worst case before the time-budget upload fix —
  // 91 ms/frame (11 fps) on this dev machine. Lock in that the
  // pitched cases stay below 25 ms median (40 fps floor) so the next
  // person who shrinks the upload budget or breaks the time-ceiling
  // condition gets a sharp signal here.
  for (const r of results) {
    expect(
      r.medianFrameMs,
      `pitch=${r.pitch}° median frame should stay under 25 ms (was ~${r.medianFrameMs.toFixed(0)} ms)`,
    ).toBeLessThan(25)
  }
})
