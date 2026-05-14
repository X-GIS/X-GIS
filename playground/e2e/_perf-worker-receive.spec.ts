// ═══════════════════════════════════════════════════════════════════
// Perf: worker → main tile reception cost during sustained pan
// ═══════════════════════════════════════════════════════════════════
//
// Fast pan motion triggers a steady stream of tile loads: every
// rAF frame moves the camera, new tiles enter the visible set,
// fetch+worker-decode → result lands on main → drain queue →
// uploadTile pipeline.
//
// User-reported: 워커에서 데이터 받을때 느려지는것도 있어요
// (data reception from workers can also be slow). This spec
// surfaces it by:
//
//   1. Loading OFM Bright (PMTiles MVT → mvt-worker-pool path)
//   2. Driving a continuous diagonal pan over 8 seconds
//   3. Measuring frame timing + counting worker resolves per frame
//   4. Reporting the worst frames + their concurrent worker activity
//
// Specifically captures the resolveQueue drain cost — the rAF
// callback that wraps transferred ArrayBuffers + resolves pending
// promises + cascades into uploadTile + bind-group construction.

import { test, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

interface FrameSample {
  idx: number
  ms: number
  /** Tiles drained from worker queue during this frame (estimated
   *  via the change in pending count between rAF callbacks). */
  resolvedTiles?: number
}

async function setupPage(page: Page, computeOptIn: boolean) {
  const url = `/demo.html?id=openfreemap_bright${computeOptIn ? '&compute=1' : ''}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // Minimal settle — just enough for first paint + pipeline prewarm.
  // Longer settle drains the worker queue so the pan never triggers
  // new tile loads, defeating the purpose of measuring receive cost.
  await page.waitForTimeout(800)
}

/** Drive a programmatic pan; capture per-frame ms + worker resolve
 *  count by polling `__xgisMap`'s pending-job counter (exposed in
 *  test mode via a small instrumentation hook). */
async function runPanWithWorkerCounting(
  page: Page, durationMs: number, dx: number, dy: number, zoomDelta: number = 0,
): Promise<{ frames: FrameSample[]; poolStats: { totalResolved: number; totalDrains: number; maxDrainSize: number; totalDrainMs: number } }> {
  return await page.evaluate(async ({ ms, dx, dy, zd }) => {
    interface MapInternals {
      camera: { centerX: number; centerY: number; zoom: number }
      invalidate: () => void
    }
    interface Pool {
      totalResolved: number; totalDrains: number;
      maxDrainSize: number; totalDrainMs: number;
      pendingCount: number; queueLength: number;
    }
    const map = (window as unknown as { __xgisMap?: MapInternals }).__xgisMap
    const pool = (globalThis as { __XGIS_MVT_POOL?: Pool }).__XGIS_MVT_POOL
    if (!map) throw new Error('__xgisMap not exposed')
    if (!pool) throw new Error('__XGIS_MVT_POOL not exposed — non-PMTiles fixture?')
    const startResolved = pool.totalResolved
    const startDrains = pool.totalDrains
    const startDrainMs = pool.totalDrainMs

    const startX = map.camera.centerX
    const startY = map.camera.centerY
    const frames: FrameSample[] = []
    return await new Promise<{
      frames: FrameSample[];
      poolStats: { totalResolved: number; totalDrains: number; maxDrainSize: number; totalDrainMs: number };
    }>((resolve) => {
      const start = performance.now()
      let last = start
      let prevResolved = pool.totalResolved
      let idx = 0
      const tick = () => {
        const now = performance.now()
        const elapsed = now - start
        const curResolved = pool.totalResolved
        const resolved = curResolved - prevResolved
        if (idx >= 2) {
          frames.push({ idx: idx - 2, ms: now - last, resolvedTiles: resolved })
        }
        last = now
        prevResolved = curResolved
        if (elapsed >= ms) {
          resolve({
            frames,
            poolStats: {
              totalResolved: pool.totalResolved - startResolved,
              totalDrains: pool.totalDrains - startDrains,
              maxDrainSize: pool.maxDrainSize,
              totalDrainMs: pool.totalDrainMs - startDrainMs,
            },
          })
          return
        }
        const t = elapsed / ms
        map.camera.centerX = startX + t * dx
        map.camera.centerY = startY + t * dy
        map.invalidate()
        idx++
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, { ms: durationMs, dx, dy, zd: zoomDelta })
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

test('OFM Bright worker receive cost — fast diagonal pan', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await setupPage(page, true) // compute=1

  const { frames, poolStats } = await runPanWithWorkerCounting(
    page, 8_000, 800_000, 400_000,
  )

  const msValues = frames.map(f => f.ms)
  const stats = {
    frames: frames.length,
    median: pct(msValues, 50),
    p90: pct(msValues, 90),
    p95: pct(msValues, 95),
    p99: pct(msValues, 99),
    worst: msValues.reduce((a, b) => Math.max(a, b), 0),
  }
  const slow = [...frames].sort((a, b) => b.ms - a.ms).slice(0, 8)

  // eslint-disable-next-line no-console
  console.log('\n════ OFM Bright worker-receive perf — fast diagonal pan ════')
  // eslint-disable-next-line no-console
  console.log(`Frames: ${stats.frames}`)
  // eslint-disable-next-line no-console
  console.log(`Worker pool — resolved ${poolStats.totalResolved} tiles across ${poolStats.totalDrains} drains`)
  // eslint-disable-next-line no-console
  console.log(`              max drain size ${poolStats.maxDrainSize} tiles`)
  // eslint-disable-next-line no-console
  console.log(`              total drain time ${poolStats.totalDrainMs.toFixed(1)} ms`
    + ` (avg ${(poolStats.totalDrainMs / Math.max(1, poolStats.totalDrains)).toFixed(2)} ms/drain,`
    + ` ${(poolStats.totalDrainMs / Math.max(1, poolStats.totalResolved)).toFixed(2)} ms/tile)`)
  // eslint-disable-next-line no-console
  console.log(`Frame ms — median ${stats.median.toFixed(1)}  p90 ${stats.p90.toFixed(1)}  `
    + `p95 ${stats.p95.toFixed(1)}  p99 ${stats.p99.toFixed(1)}  worst ${stats.worst.toFixed(0)}`)
  // eslint-disable-next-line no-console
  console.log('\nTop 8 slow frames (idx ms tiles-resolved-that-frame):')
  for (const f of slow) {
    // eslint-disable-next-line no-console
    console.log(`  idx=${String(f.idx).padStart(4)}  ${f.ms.toFixed(1).padStart(6)} ms  resolved=${f.resolvedTiles ?? 0}`)
  }

  // Correlate: frames with ≥1 resolved tile vs frames with 0.
  const withR = frames.filter(f => (f.resolvedTiles ?? 0) > 0).map(f => f.ms)
  const noR = frames.filter(f => (f.resolvedTiles ?? 0) === 0).map(f => f.ms)
  // eslint-disable-next-line no-console
  console.log(`\nFrames WITH tile resolves: n=${withR.length}  median ${withR.length ? pct(withR, 50).toFixed(1) : '—'}  worst ${withR.length ? withR.reduce((a, b) => Math.max(a, b), 0).toFixed(0) : '—'}`)
  // eslint-disable-next-line no-console
  console.log(`Frames WITHOUT resolves:   n=${noR.length}   median ${noR.length ? pct(noR, 50).toFixed(1) : '—'}  worst ${noR.length ? noR.reduce((a, b) => Math.max(a, b), 0).toFixed(0) : '—'}`)
})

test('OFM Bright sustained pan smoothness — single-direction', async ({ page }) => {
  // Different motion shape: single-direction east pan, longer
  // duration, smaller velocity. Steady-state worker pressure
  // (no LOD transition).
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await setupPage(page, true)

  const { frames, poolStats } = await runPanWithWorkerCounting(
    page, 6_000, 300_000, 0,
  )
  const ms = frames.map(f => f.ms)
  // eslint-disable-next-line no-console
  console.log('\n════ Sustained east pan z=12 ════')
  // eslint-disable-next-line no-console
  console.log(`Frames ${frames.length}  resolved ${poolStats.totalResolved}  drains ${poolStats.totalDrains}  drainMs ${poolStats.totalDrainMs.toFixed(1)}`)
  // eslint-disable-next-line no-console
  console.log(`Frame ms — median ${pct(ms, 50).toFixed(1)}  p99 ${pct(ms, 99).toFixed(1)}  worst ${ms.reduce((a, b) => Math.max(a, b), 0).toFixed(0)}`)
})
