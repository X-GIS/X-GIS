// E2E performance measurement for the PMTiles + MVT pipeline.
//
// Uses Chromium's DevTools Profiler domain via CDP to capture a
// real CPU profile (same format the DevTools Performance tab
// records). Outputs:
//
//   1. .cpuprofile artifact at test-results/pmtiles-v4-perf.cpuprofile
//      Drag onto chrome://devtools Performance tab to inspect like
//      a manual recording.
//
//   2. Top-20 hot functions by self time, printed to test stdout.
//      Identifies regression hot paths without manual DevTools work.
//
//   3. FPS + frame-time percentiles (p50/p95/p99) over the
//      measurement window. The "interactive feel" oracle.
//
// Workload: load the v4 archive at z=10 over Tokyo (representative
// dense urban view), let the initial fetch + compile + upload
// pipeline run for 5s under instrumentation. Replicates the user-
// reported "buildLineSegments dominates frame" condition without
// needing manual profiling each time.

import { test, expect, type Page, type CDPSession } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  hitCount?: number
  children?: number[]
}
interface CpuProfile {
  nodes: ProfileNode[]
  startTime: number
  endTime: number
  samples?: number[]
  timeDeltas?: number[]
}

async function waitForXgisReady(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 60_000 },
  )
}

/** Aggregate self time per call-frame from a CDP profile.
 *  Self time = (hits where this node is on top of the stack) ×
 *  sampling interval. CDP records hits via the (samples, timeDeltas)
 *  parallel arrays — samples[i] is the node id at the top of the
 *  stack at time t, timeDeltas[i] is microseconds since the previous
 *  sample. */
function topHotFunctions(profile: CpuProfile, topN = 20) {
  const selfMicros = new Map<number, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i]
    const dt = deltas[i] ?? 0
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + dt)
  }
  const totalMicros = (profile.endTime - profile.startTime)
  const rows = profile.nodes.map(n => {
    const self = selfMicros.get(n.id) ?? 0
    return {
      name: n.callFrame.functionName || '(anonymous)',
      url: n.callFrame.url || '',
      line: n.callFrame.lineNumber,
      selfMs: self / 1000,
      selfPct: totalMicros > 0 ? (self / totalMicros) * 100 : 0,
    }
  })
  rows.sort((a, b) => b.selfMs - a.selfMs)
  return rows.slice(0, topN)
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

async function recordProfile(cdp: CDPSession, durationMs: number): Promise<CpuProfile> {
  await cdp.send('Profiler.enable')
  // 100us interval = 10 kHz sampling. Default is 1ms = 1 kHz.
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
  await cdp.send('Profiler.start')
  await new Promise(r => setTimeout(r, durationMs))
  const stopped = await cdp.send('Profiler.stop') as { profile: CpuProfile }
  await cdp.send('Profiler.disable')
  return stopped.profile
}

/** Run an in-page rAF loop, recording per-frame deltas for `durationMs`.
 *  Returns timing summary. */
async function measureFrames(page: Page, durationMs: number): Promise<{
  frames: number; ms: number; fps: number;
  p50: number; p95: number; p99: number;
}> {
  const result = await page.evaluate(async (durationMs: number) => {
    return await new Promise<{ times: number[] }>(resolve => {
      const times: number[] = []
      const t0 = performance.now()
      let last = t0
      const loop = (t: number) => {
        times.push(t - last)
        last = t
        if (t - t0 < durationMs) requestAnimationFrame(loop)
        else resolve({ times })
      }
      requestAnimationFrame(loop)
    })
  }, durationMs)
  // Drop the very first sample (initial-frame outlier).
  const times = result.times.slice(1)
  const total = times.reduce((a, b) => a + b, 0)
  return {
    frames: times.length,
    ms: total,
    fps: times.length > 0 ? (times.length * 1000) / total : 0,
    p50: pct(times, 50),
    p95: pct(times, 95),
    p99: pct(times, 99),
  }
}

test('PMTiles v4 perf: load + warmup at Tokyo z=10', async ({ page, context }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 720 })

  const consoleErrors: string[] = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  await page.goto('/demo.html?id=pmtiles_v4#10/35.68/139.76', { waitUntil: 'domcontentloaded' })
  await waitForXgisReady(page)
  // Brief settle so the very-first-frame outliers don't dominate.
  await page.waitForTimeout(500)

  // Profile + measure frames in parallel for 5 seconds.
  const cdp = await context.newCDPSession(page)
  const PROFILE_MS = 5000
  const [profile, frames] = await Promise.all([
    recordProfile(cdp, PROFILE_MS),
    measureFrames(page, PROFILE_MS),
  ])

  // Save the .cpuprofile for manual inspection in DevTools.
  const outPath = path.resolve('test-results', 'pmtiles-v4-perf.cpuprofile')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(profile))
  console.log(`\n[profile] saved: ${outPath} (drag onto DevTools Performance tab)`)

  // Frame-time summary.
  console.log(`\n[frames] ${frames.frames} frames in ${frames.ms.toFixed(0)} ms`)
  console.log(`[frames] FPS=${frames.fps.toFixed(1)}  p50=${frames.p50.toFixed(1)}ms  p95=${frames.p95.toFixed(1)}ms  p99=${frames.p99.toFixed(1)}ms`)

  // Hot-function breakdown.
  console.log(`\n[hot] top 20 by self time:`)
  const hot = topHotFunctions(profile, 20)
  for (const r of hot) {
    const url = r.url ? r.url.split('/').slice(-2).join('/') : ''
    console.log(`  ${r.selfMs.toFixed(1).padStart(7)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(35)} ${url}:${r.line}`)
  }

  // Catalog state at end.
  const cat = await page.evaluate(() => {
    type Cat = { maxLevel: number; getCacheSize(): number; getPendingLoadCount(): number }
    const m = (window as unknown as { __xgisMap?: { vtSources?: Map<string, { source: Cat }> } }).__xgisMap
    const e = m?.vtSources?.get('pm')
    return e ? { cacheSize: e.source.getCacheSize(), pending: e.source.getPendingLoadCount() } : null
  })
  console.log(`\n[catalog] ${JSON.stringify(cat)}`)

  // Sanity: no console errors during the warmup.
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0)
  // Soft-assert: warn (don't fail) if FPS is below 30. The number is
  // a moving target until worker offload lands.
  if (frames.fps < 30) {
    console.warn(`\n[perf-warn] FPS ${frames.fps.toFixed(1)} < 30 target — frame-bound work too heavy.`)
  }
})

test('PMTiles v4 perf: zoom-in over Seoul (z=8 → z=14)', async ({ page, context }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 720 })

  // Start zoomed-out at z=8 over Seoul.
  await page.goto('/demo.html?id=pmtiles_v4#8/37.5665/126.9780', { waitUntil: 'domcontentloaded' })
  await waitForXgisReady(page)
  await page.waitForTimeout(2500) // initial z=8 load settle

  const cdp = await context.newCDPSession(page)
  const PROFILE_MS = 6000

  // Smooth zoom-in from z=8 → z=14 across PROFILE_MS. Each step
  // forces a new LOD level to fetch + compile, the worst case for
  // PMTiles since old z tiles get evicted while new z tiles stream
  // in fresh.
  const zoomTask = (async () => {
    const start = Date.now()
    const zStart = 8
    const zEnd = 14
    while (Date.now() - start < PROFILE_MS) {
      const t = (Date.now() - start) / PROFILE_MS
      const z = zStart + (zEnd - zStart) * t
      await page.evaluate((z: number) => {
        location.hash = `#${z.toFixed(2)}/37.56650/126.97800`
      }, z)
      await page.waitForTimeout(80) // ~12 Hz zoom updates
    }
  })()

  const [profile, frames] = await Promise.all([
    recordProfile(cdp, PROFILE_MS),
    measureFrames(page, PROFILE_MS),
    zoomTask,
  ])

  const outPath = path.resolve('test-results', 'pmtiles-v4-perf-seoul-zoom.cpuprofile')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(profile))
  console.log(`\n[profile] saved: ${outPath}`)
  console.log(`[frames] ${frames.frames} frames in ${frames.ms.toFixed(0)} ms`)
  console.log(`[frames] FPS=${frames.fps.toFixed(1)}  p50=${frames.p50.toFixed(1)}ms  p95=${frames.p95.toFixed(1)}ms  p99=${frames.p99.toFixed(1)}ms`)
  const hot = topHotFunctions(profile, 20)
  console.log(`\n[hot] top 20 (Seoul zoom z=8→14):`)
  for (const r of hot) {
    const url = r.url ? r.url.split('/').slice(-2).join('/') : ''
    console.log(`  ${r.selfMs.toFixed(1).padStart(7)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(35)} ${url}:${r.line}`)
  }

  const cat = await page.evaluate(() => {
    type Cat = { maxLevel: number; getCacheSize(): number; getPendingLoadCount(): number }
    const m = (window as unknown as { __xgisMap?: { vtSources?: Map<string, { source: Cat }> } }).__xgisMap
    const e = m?.vtSources?.get('pm')
    return e ? { cacheSize: e.source.getCacheSize(), pending: e.source.getPendingLoadCount() } : null
  })
  console.log(`\n[catalog] ${JSON.stringify(cat)}`)
})

test('PMTiles v4 perf: zoom-in over Beijing (z=8 → z=14)', async ({ page, context }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 720 })

  await page.goto('/demo.html?id=pmtiles_v4#8/39.9042/116.4074', { waitUntil: 'domcontentloaded' })
  await waitForXgisReady(page)
  await page.waitForTimeout(2500)

  const cdp = await context.newCDPSession(page)
  const PROFILE_MS = 6000

  const zoomTask = (async () => {
    const start = Date.now()
    while (Date.now() - start < PROFILE_MS) {
      const t = (Date.now() - start) / PROFILE_MS
      const z = 8 + 6 * t
      await page.evaluate((z: number) => {
        location.hash = `#${z.toFixed(2)}/39.90420/116.40740`
      }, z)
      await page.waitForTimeout(80)
    }
  })()

  const [profile, frames] = await Promise.all([
    recordProfile(cdp, PROFILE_MS),
    measureFrames(page, PROFILE_MS),
    zoomTask,
  ])

  const outPath = path.resolve('test-results', 'pmtiles-v4-perf-beijing-zoom.cpuprofile')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(profile))
  console.log(`\n[profile] saved: ${outPath}`)
  console.log(`[frames] ${frames.frames} frames in ${frames.ms.toFixed(0)} ms`)
  console.log(`[frames] FPS=${frames.fps.toFixed(1)}  p50=${frames.p50.toFixed(1)}ms  p95=${frames.p95.toFixed(1)}ms  p99=${frames.p99.toFixed(1)}ms`)
  const hot = topHotFunctions(profile, 15)
  console.log(`\n[hot] top 15 (Beijing zoom z=8→14):`)
  for (const r of hot) {
    const url = r.url ? r.url.split('/').slice(-2).join('/') : ''
    console.log(`  ${r.selfMs.toFixed(1).padStart(7)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(35)} ${url}:${r.line}`)
  }
  const cat = await page.evaluate(() => {
    type Cat = { maxLevel: number; getCacheSize(): number; getPendingLoadCount(): number }
    const m = (window as unknown as { __xgisMap?: { vtSources?: Map<string, { source: Cat }> } }).__xgisMap
    const e = m?.vtSources?.get('pm')
    return e ? { cacheSize: e.source.getCacheSize(), pending: e.source.getPendingLoadCount() } : null
  })
  console.log(`\n[catalog] ${JSON.stringify(cat)}`)
})

test('PMTiles v4 perf: programmatic pan stress', async ({ page, context }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 720 })

  await page.goto('/demo.html?id=pmtiles_v4#10/35.68/139.76', { waitUntil: 'domcontentloaded' })
  await waitForXgisReady(page)
  await page.waitForTimeout(2000) // initial load settle

  const cdp = await context.newCDPSession(page)
  const PROFILE_MS = 5000

  // Start profile + frame measurement, then pan continuously by
  // mutating the URL hash. demo-runner picks up hash changes and
  // applies them to the camera.
  const panTask = (async () => {
    const start = Date.now()
    let i = 0
    while (Date.now() - start < PROFILE_MS) {
      // Slow circular pan around Tokyo center to force tile turnover.
      const angle = (i++ * 0.05)
      const lat = 35.68 + Math.sin(angle) * 0.1
      const lon = 139.76 + Math.cos(angle) * 0.15
      await page.evaluate(({ lat, lon }) => {
        location.hash = `#10/${lat.toFixed(5)}/${lon.toFixed(5)}`
      }, { lat, lon })
      await page.waitForTimeout(100) // ~10 Hz pan updates
    }
  })()

  const [profile, frames] = await Promise.all([
    recordProfile(cdp, PROFILE_MS),
    measureFrames(page, PROFILE_MS),
    panTask,
  ])

  const outPath = path.resolve('test-results', 'pmtiles-v4-perf-pan.cpuprofile')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(profile))
  console.log(`\n[profile] saved: ${outPath}`)
  console.log(`[frames] ${frames.frames} frames in ${frames.ms.toFixed(0)} ms`)
  console.log(`[frames] FPS=${frames.fps.toFixed(1)}  p50=${frames.p50.toFixed(1)}ms  p95=${frames.p95.toFixed(1)}ms  p99=${frames.p99.toFixed(1)}ms`)
  const hot = topHotFunctions(profile, 15)
  console.log(`\n[hot] top 15:`)
  for (const r of hot) {
    const url = r.url ? r.url.split('/').slice(-2).join('/') : ''
    console.log(`  ${r.selfMs.toFixed(1).padStart(7)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(35)} ${url}:${r.line}`)
  }
})
