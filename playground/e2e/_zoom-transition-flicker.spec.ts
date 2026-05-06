// Diagnostic spec for "zoom transition flicker" — observation only.
//
// Drives camera.zoom programmatically through a controlled transition
// (default 3 → 6 in ~30 ticks) and captures per-frame state:
//
//   * drawCalls / tilesVisible / missedTiles  — VTR.getDrawStats()
//   * pendingUploads / gpuCacheCount          — VTR diagnostic API
//   * screenshot (every Nth frame)            — visual coverage check
//   * camera.zoom + timestamp                 — for plotting
//
// Outputs:
//   playground/e2e/__zoom-flicker__/timeline.json   — frame-by-frame state
//   playground/e2e/__zoom-flicker__/frame-XXX.jpg   — sampled screenshots
//
// Hypothesis being tested: VTR's `_uploadBudget = 3` per frame
// throttles tile arrival during zoom transition; visible "flicker" is
// the layered fallback-→-native swap as 12 tiles/frame trickle in
// across 4 layers. The timeline.json should show a multi-frame stretch
// where pendingUploads > 0 and tilesVisible / missedTiles oscillate.

import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname_eq = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname_eq, '__zoom-flicker__')
mkdirSync(OUT_DIR, { recursive: true })

interface FrameSnapshot {
  /** Wall-clock ms relative to test start. */
  t: number
  /** Tick index (0..ticks) of the zoom-driver loop. */
  tick: number
  /** Camera zoom at the time the snapshot was captured. */
  cameraZoom: number
  /** Camera frame counter (map._frameCount) — counts actual renderFrame
   *  calls, useful to spot dropped frames in the driver loop. */
  frameCount: number
  /** Per-VTR (per ShowCommand) diagnostic state. Keyed by source name
   *  + show index. PMTiles demos with N layers produce N entries. */
  vtrs: Array<{
    sourceName: string
    drawCalls: number
    tilesVisible: number
    missedTiles: number
    triangles: number
    lines: number
    pendingUploads: number
    gpuCacheCount: number
  }>
}

test.describe('Zoom transition flicker — diagnostic', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('pmtiles_layered: zoom 3 → 6 over ~30 ticks, capture per-frame state', async ({ page }) => {
    test.setTimeout(90_000)

    // pmtiles_layered: 4 source-layers (water/landuse/roads/buildings)
    // — most stressed config because 4 VTR uploads concurrently. The
    // hash drops the camera onto Tokyo so all 4 layers have data to
    // resolve at every zoom step.
    await page.goto(
      `/demo.html?id=pmtiles_layered#3.0/35.68/139.76`,
      { waitUntil: 'domcontentloaded' },
    )

    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 },
    )
    // Settle initial load — wait for tilesVisible > 0 (real steady
    // state). pendingUploads === 0 is satisfied trivially before any
    // fetch even starts, so we'd race the catalog's first request
    // pass otherwise.
    await page.waitForFunction(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = (window as any).__xgisMap
      if (!map?.vtSources) return false
      let totalVisible = 0
      let pending = 0
      for (const { renderer } of map.vtSources.values()) {
        const ds = renderer.getDrawStats?.() ?? { tilesVisible: 0 }
        totalVisible += ds.tilesVisible
        pending += renderer.getPendingUploadCount?.() ?? 0
      }
      return totalVisible > 0 && pending === 0
    }, null, { timeout: 60_000 })
    // Give it a couple of beats to make sure all 4 layers' tiles
    // are GPU-resident, not just the first one to render.
    await page.waitForTimeout(2000)

    // Snapshot screenshots at every Nth tick so we can visually inspect
    // the transition. Saved as frame-NN.jpg under __zoom-flicker__/.
    // Re-imported here outside the page context.
    const SCREENSHOT_INTERVAL = 2

    // Drive the zoom transition. We call requestAnimationFrame inside
    // the page so the zoom changes lock-step with the render loop —
    // setTimeout-based driving would race the rAF cadence and produce
    // a less-clean trace.
    const samples = await page.evaluate(async (cfg) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = (window as any).__xgisMap
      if (!map?.camera || !map.vtSources) return []

      const samples: FrameSnapshotPage[] = []
      const tStart = performance.now()
      const startZoom = cfg.startZoom
      const endZoom = cfg.endZoom
      const ticks = cfg.ticks
      const dz = (endZoom - startZoom) / ticks

      function snap(tick: number): FrameSnapshotPage {
        const vtrs: FrameSnapshotPage['vtrs'] = []
        for (const [sourceName, entry] of map.vtSources.entries()) {
          const r = entry.renderer
          const ds = r.getDrawStats?.() ?? {}
          vtrs.push({
            sourceName,
            drawCalls: ds.drawCalls ?? 0,
            tilesVisible: ds.tilesVisible ?? 0,
            missedTiles: ds.missedTiles ?? 0,
            triangles: ds.triangles ?? 0,
            lines: ds.lines ?? 0,
            pendingUploads: r.getPendingUploadCount?.() ?? 0,
            gpuCacheCount: r.getCacheSize?.() ?? 0,
          })
        }
        return {
          t: performance.now() - tStart,
          tick,
          cameraZoom: map.camera.zoom,
          frameCount: map._frameCount ?? 0,
          vtrs,
        }
      }

      // Snapshot before any zoom change — baseline.
      samples.push(snap(-1))

      // Drive zoom forward. Each tick: change zoom, await one rAF so
      // the renderer composes a frame at the new zoom, then snapshot.
      // Extra rAFs after the last zoom step let pendingUploads drain
      // so we can see the recovery curve in the same trace.
      for (let i = 0; i <= cfg.ticks; i++) {
        map.camera.zoom = cfg.startZoom + dz * i
        // 2× rAF: first lets the render encode + submit; second lets
        // any newly-uploaded tile reach the next-frame swap chain.
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))
        samples.push(snap(i))
      }

      // Now reverse — zoom OUT back to start. Same flicker class but
      // exercises the parent-fallback path differently (camera has
      // tiles loaded at the destination, but new "zoom out" view
      // requires lower-z parents that may have been evicted).
      for (let i = 0; i <= cfg.ticks; i++) {
        map.camera.zoom = cfg.endZoom - dz * i
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))
        samples.push(snap(cfg.ticks + 1 + i))
      }

      // Tail: 60 extra frames at final zoom so we can see when
      // pendingUploads converges to 0 (recovery time).
      for (let i = 0; i < 60; i++) {
        await new Promise<void>(r => requestAnimationFrame(() => r()))
        samples.push(snap(2 * cfg.ticks + 2 + i))
      }

      return samples
    }, { startZoom: 3.0, endZoom: 6.0, ticks: 30 })

    // Sequential screenshots at every Nth tick so we can visually
    // inspect the transition. Done OUTSIDE page.evaluate so we can use
    // the test's full-page screenshot capability + Node fs.
    // Note: this does a second pass — the first pass collected stats
    // but didn't take screenshots (Playwright screenshots block ~50ms
    // each and would distort the timing trace).
    await page.goto(
      `/demo.html?id=pmtiles_layered#3.0/35.68/139.76`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = (window as any).__xgisMap
      if (!map?.vtSources) return false
      let totalVisible = 0, pending = 0
      for (const { renderer } of map.vtSources.values()) {
        totalVisible += renderer.getDrawStats?.().tilesVisible ?? 0
        pending += renderer.getPendingUploadCount?.() ?? 0
      }
      return totalVisible > 0 && pending === 0
    }, null, { timeout: 60_000 })
    await page.waitForTimeout(2000)

    for (let i = 0; i <= 30; i += SCREENSHOT_INTERVAL) {
      await page.evaluate((zoom) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(window as any).__xgisMap.camera.zoom = zoom
        return new Promise<void>(r => requestAnimationFrame(() =>
          requestAnimationFrame(() => r())
        ))
      }, 3.0 + (3.0 / 30) * i)
      const buf = await page.locator('#map').screenshot({ type: 'jpeg', quality: 70 })
      writeFileSync(join(OUT_DIR, `frame-${String(i).padStart(3, '0')}-z${(3.0 + (3.0 / 30) * i).toFixed(2)}.jpg`), buf)
    }

    interface FrameSnapshotPage extends FrameSnapshot {}

    // Coerce shape — page.evaluate returns plain JSON.
    const timeline = samples as FrameSnapshot[]

    writeFileSync(
      join(OUT_DIR, 'timeline.json'),
      JSON.stringify(timeline, null, 2),
    )

    // Brief stdout summary so the spec's log conveys the diagnosis
    // without requiring the JSON file open.
    const peakPending = Math.max(...timeline.flatMap(s => s.vtrs.map(v => v.pendingUploads)))
    const totalTilesEnd = timeline.at(-1)!.vtrs.reduce((sum, v) => sum + v.tilesVisible, 0)
    const totalTilesStart = timeline[0].vtrs.reduce((sum, v) => sum + v.tilesVisible, 0)
    const recoveryFrame = timeline.findIndex(
      (s, i) => i > 30 && s.vtrs.every(v => v.pendingUploads === 0),
    )
    const recoveryMs = recoveryFrame >= 0 ? timeline[recoveryFrame].t - timeline[30].t : -1
    console.log('\n=== Zoom transition diagnostic summary ===')
    console.log(`  Frames captured:        ${timeline.length}`)
    console.log(`  Peak pendingUploads:    ${peakPending} (across all VTRs)`)
    console.log(`  tilesVisible: start=${totalTilesStart}, end=${totalTilesEnd}`)
    console.log(`  Recovery to 0 pending:  ${recoveryMs >= 0 ? `${recoveryMs.toFixed(0)} ms after final zoom step` : 'NEVER (still pending at end of capture)'}`)
    console.log(`  Per-VTR final state:`)
    for (const v of timeline.at(-1)!.vtrs) {
      console.log(`    ${v.sourceName.padEnd(20)} tilesVisible=${v.tilesVisible} missed=${v.missedTiles} gpu=${v.gpuCacheCount} pending=${v.pendingUploads}`)
    }
    console.log(`  Output: ${OUT_DIR}/timeline.json`)
  })
})
