// Performance-scenario sweep: pan/zoom at various speeds, measure frame
// drops + GPU buffer churn to find the real bottlenecks.
//
// For each scenario we:
//   1. Monkey-patch device.queue.writeBuffer to count calls + total bytes
//      per frame.
//   2. Drive the camera through the scenario (pan, zoom, or combined).
//   3. Record per-frame wall-clock + writeBuffer telemetry.
//   4. Emit aggregate stats: fps p50/p95/max, drop counts at 16/33/100 ms,
//      writeBuffer avg/peak/frame.
//
// Output: playground/__perf-scenarios__/report.json with every scenario's
// per-frame arrays + aggregates, so we can compare future runs.

import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART_DIR = join(HERE, '__perf-scenarios__')
mkdirSync(ART_DIR, { recursive: true })

const VIEW = { width: 1400, height: 800 }

interface FrameSample {
  t: number             // ms since scenario start
  dt: number            // frame delta ms
  writeBufCount: number // writeBuffer calls since previous frame
  writeBufBytes: number // bytes written since previous frame
}

interface ScenarioResult {
  name: string
  durationMs: number
  frames: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  dropsAt16: number
  dropsAt33: number
  dropsAt100: number
  writeBuf: {
    total: number
    avgPerFrame: number
    peakPerFrame: number
    totalBytes: number
    avgBytesPerFrame: number
    peakBytesPerFrame: number
  }
  samples: FrameSample[]
}

test('perf scenarios @zoom pan', async ({ page }) => {
  test.setTimeout(300_000)
  await page.setViewportSize(VIEW)

  page.on('pageerror', (err) => console.log('[pageerror]', err.message))

  await page.goto('/demo.html?id=minimal&e2e=1#0.00/0.00000/0.00', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 20_000 },
  )
  await page.waitForTimeout(2000) // let worker compile + tile loads settle

  // Install writeBuffer counter on the live GPUDevice. Exposes a global
  // reset/snapshot so each scenario can measure just its own interval.
  await page.evaluate(() => {
    const win = window as unknown as {
      __xgisMap?: { ctx?: { device: GPUDevice } }
      __perf?: { count: number; bytes: number }
      __perfReset?: () => void
      __perfSnapshot?: () => { count: number; bytes: number }
    }
    const device = win.__xgisMap?.ctx?.device
    if (!device) throw new Error('no device')
    const origWrite = device.queue.writeBuffer.bind(device.queue)
    win.__perf = { count: 0, bytes: 0 }
    device.queue.writeBuffer = ((
      buffer: GPUBuffer, offset: number, data: BufferSource, dataOffset?: number, size?: number,
    ) => {
      win.__perf!.count++
      // Data can be ArrayBuffer or typed-array view; both expose byteLength.
      const len = size ?? (data as ArrayBufferView).byteLength ?? (data as ArrayBuffer).byteLength ?? 0
      win.__perf!.bytes += len
      return origWrite(buffer, offset, data, dataOffset as number, size as number)
    }) as typeof device.queue.writeBuffer
    win.__perfReset = () => { win.__perf!.count = 0; win.__perf!.bytes = 0 }
    win.__perfSnapshot = () => ({ count: win.__perf!.count, bytes: win.__perf!.bytes })
  })

  // Run one scenario: `driver` mutates the camera each frame until it
  // returns `true`. We sample frame delta + writeBuffer churn around
  // each rAF tick.
  async function runScenario(
    name: string,
    driver: (win: Window & typeof globalThis, tMs: number) => boolean,
  ): Promise<ScenarioResult> {
    // Serialize the driver so page.evaluate can run it. The caller passes
    // a pure function that closes over nothing outside the argument.
    const driverSrc = driver.toString()
    const raw = await page.evaluate(async (src) => {
      const win = window as unknown as {
        __xgisMap?: { camera: { centerX: number; centerY: number; zoom: number; zoomAt?: unknown } }
        __perf?: { count: number; bytes: number }
        __perfReset?: () => void
      }
      const map = win.__xgisMap!
      // Rebuild the driver function inside the page scope.
      // eslint-disable-next-line no-new-func
      const fn = new Function('return (' + src + ')')() as (w: Window & typeof globalThis, t: number) => boolean

      win.__perfReset!()
      const samples: FrameSample[] = []
      const t0 = performance.now()
      let lastT = t0
      let lastCount = 0, lastBytes = 0

      await new Promise<void>((resolve) => {
        function tick() {
          const tNow = performance.now()
          const tRel = tNow - t0
          const dt = tNow - lastT
          const count = win.__perf!.count, bytes = win.__perf!.bytes
          samples.push({
            t: tRel, dt,
            writeBufCount: count - lastCount,
            writeBufBytes: bytes - lastBytes,
          })
          lastT = tNow; lastCount = count; lastBytes = bytes

          const done = fn(window as unknown as Window & typeof globalThis, tRel)
          // Ensure controller state stays sane across programmatic drives;
          // if the scenario sets camera but the controller fights back we
          // still just keep running — idle-when-static means stale frames
          // just won't paint.
          void map
          if (done) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      return { samples, totalMs: performance.now() - t0 }
    }, driverSrc)

    const samples = raw.samples as FrameSample[]
    // Drop the first 2 samples — rAF boundary effects inflate dt spuriously.
    const fs = samples.slice(2)
    const dts = fs.map(s => s.dt).sort((a, b) => a - b)
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
    const pct = (xs: number[], p: number) => xs[Math.floor(xs.length * p)] ?? 0

    const wbCounts = fs.map(s => s.writeBufCount)
    const wbBytes = fs.map(s => s.writeBufBytes)

    return {
      name,
      durationMs: raw.totalMs,
      frames: fs.length,
      avgMs: sum(dts) / dts.length,
      p50Ms: pct(dts, 0.5),
      p95Ms: pct(dts, 0.95),
      maxMs: dts[dts.length - 1] ?? 0,
      dropsAt16: dts.filter(d => d > 16.7).length,
      dropsAt33: dts.filter(d => d > 33.4).length,
      dropsAt100: dts.filter(d => d > 100).length,
      writeBuf: {
        total: sum(wbCounts),
        avgPerFrame: sum(wbCounts) / Math.max(1, wbCounts.length),
        peakPerFrame: Math.max(0, ...wbCounts),
        totalBytes: sum(wbBytes),
        avgBytesPerFrame: sum(wbBytes) / Math.max(1, wbBytes.length),
        peakBytesPerFrame: Math.max(0, ...wbBytes),
      },
      samples: fs,
    }
  }

  // Helper: reset camera to a known start between scenarios.
  async function resetCamera(centerLon: number, zoom: number): Promise<void> {
    await page.evaluate(({ lon, z }) => {
      const R = 6378137
      const map = (window as unknown as { __xgisMap?: { camera: { centerX: number; centerY: number; zoom: number } } }).__xgisMap!
      map.camera.centerX = lon * Math.PI / 180 * R
      map.camera.centerY = 0
      map.camera.zoom = z
    }, { lon: centerLon, z: zoom })
    await page.waitForTimeout(500) // let cache settle after the jump
  }

  const scenarios: ScenarioResult[] = []

  // ── 1. Idle: no interaction. Ideal = 0 writeBuffer calls, ~0 renders ──
  await resetCamera(0, 0)
  scenarios.push(await runScenario('idle-zoom0', (w, t) => t >= 2000))

  // ── 2. Slow pan: 360° over 5 seconds at z=0 ──
  await resetCamera(0, 0)
  scenarios.push(await runScenario('slow-pan-z0', (w, t) => {
    const R = 6378137
    const map = (w as unknown as { __xgisMap: { camera: { centerX: number } } }).__xgisMap
    const u = Math.min(1, t / 5000)
    map.camera.centerX = (360 * u - 180) * Math.PI / 180 * R
    return t >= 5000
  }))

  // ── 3. Fast flick: 360° in 200ms ──
  await resetCamera(0, 0)
  scenarios.push(await runScenario('fast-flick-z0', (w, t) => {
    const R = 6378137
    const map = (w as unknown as { __xgisMap: { camera: { centerX: number } } }).__xgisMap
    const u = Math.min(1, t / 200)
    map.camera.centerX = (360 * u - 180) * Math.PI / 180 * R
    return t >= 500 // include 300ms of settle
  }))

  // ── 4. Slow zoom: z=0 → z=6 over 5 seconds ──
  await resetCamera(0, 0)
  scenarios.push(await runScenario('slow-zoom-in', (w, t) => {
    const map = (w as unknown as { __xgisMap: { camera: { zoom: number } } }).__xgisMap
    const u = Math.min(1, t / 5000)
    map.camera.zoom = u * 6
    return t >= 5000
  }))

  // ── 5. Fast zoom: z=0 → z=8 over 300ms ──
  await resetCamera(0, 0)
  scenarios.push(await runScenario('fast-zoom-in', (w, t) => {
    const map = (w as unknown as { __xgisMap: { camera: { zoom: number } } }).__xgisMap
    const u = Math.min(1, t / 300)
    map.camera.zoom = u * 8
    return t >= 1000 // include 700ms settle
  }))

  // ── 6. Zoom oscillation: scroll-spam style ──
  await resetCamera(0, 3)
  scenarios.push(await runScenario('zoom-oscillate', (w, t) => {
    const map = (w as unknown as { __xgisMap: { camera: { zoom: number } } }).__xgisMap
    map.camera.zoom = 3 + 3 * Math.sin(t / 80) // 3-to-6 oscillation, ~12 Hz
    return t >= 3000
  }))

  // ── 7. Pan + zoom combined ──
  await resetCamera(0, 0)
  scenarios.push(await runScenario('pan-plus-zoom', (w, t) => {
    const R = 6378137
    const map = (w as unknown as { __xgisMap: { camera: { centerX: number; zoom: number } } }).__xgisMap
    const u = Math.min(1, t / 3000)
    map.camera.centerX = (180 * u) * Math.PI / 180 * R
    map.camera.zoom = u * 5
    return t >= 3000
  }))

  // Emit a compact aggregate-only summary for the log, plus the full
  // report (with per-frame samples) to disk.
  const summary = scenarios.map(s => ({
    name: s.name,
    frames: s.frames,
    fps_avg: Math.round(1000 / s.avgMs),
    p50: +s.p50Ms.toFixed(1),
    p95: +s.p95Ms.toFixed(1),
    max: +s.maxMs.toFixed(1),
    drops_16: s.dropsAt16,
    drops_33: s.dropsAt33,
    drops_100: s.dropsAt100,
    wb_total: s.writeBuf.total,
    wb_avg: +s.writeBuf.avgPerFrame.toFixed(1),
    wb_peak: s.writeBuf.peakPerFrame,
    wb_MB: +(s.writeBuf.totalBytes / 1024 / 1024).toFixed(2),
    wb_peak_KB: +(s.writeBuf.peakBytesPerFrame / 1024).toFixed(1),
  }))
  console.log('PERF_SUMMARY:', JSON.stringify(summary, null, 2))
  writeFileSync(join(ART_DIR, 'report.json'), JSON.stringify({ summary, scenarios }, null, 2))
})
