// Targeted CPU profile for the 16-second stall seen in
// hybrid-slow-zoom-to-max. Runs just that scenario with Chromium's
// Profiler enabled so we can see WHICH JS function consumed the
// blocked wall time, not just that the stall happened.

import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART_DIR = join(HERE, '__perf-scenarios__')
mkdirSync(ART_DIR, { recursive: true })

test('hybrid slow-zoom CPU profile', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1400, height: 800 })

  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('[gen-subtile]') || t.includes('[prefetch-adjacent]') || t.includes('[HOT]')) {
      console.log(t)
    }
  })

  await page.goto('/demo.html?id=raster&e2e=1#0.00/-33.87/151.21', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 20_000 },
  )
  await page.waitForTimeout(3000) // cache settle

  // Reset camera to z=0 at Sydney before profiling.
  await page.evaluate(() => {
    const R = 6378137
    const map = (window as unknown as { __xgisMap?: { camera: { centerX: number; centerY: number; zoom: number } } }).__xgisMap!
    map.camera.centerX = 151.21 * Math.PI / 180 * R
    const latRad = -33.87 * Math.PI / 180
    map.camera.centerY = Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * R
    map.camera.zoom = 0
  })
  await page.waitForTimeout(1500)

  // Start Chromium profiler via CDP. 200 µs interval — enough resolution
  // to see sub-ms frame work but not so fine that the profile itself
  // dominates runtime.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')

  // Run slow-zoom scenario inline and collect per-frame samples.
  const frames = await page.evaluate(() => new Promise<{ t: number; dt: number }[]>((resolve) => {
    const R = 6378137
    const map = (window as unknown as { __xgisMap: { camera: { centerX: number; centerY: number; zoom: number } } }).__xgisMap
    // Reset camera (redundant, but just in case)
    const latRad = -33.87 * Math.PI / 180
    map.camera.centerX = 151.21 * Math.PI / 180 * R
    map.camera.centerY = Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * R
    map.camera.zoom = 0
    const samples: { t: number; dt: number }[] = []
    const t0 = performance.now()
    let last = t0
    function tick() {
      const now = performance.now()
      const tRel = now - t0
      samples.push({ t: tRel, dt: now - last })
      last = now
      const u = Math.min(1, tRel / 10_000)
      map.camera.zoom = u * 18
      if (tRel >= 12_000) resolve(samples)
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }))

  const { profile } = await cdp.send('Profiler.stop')

  // Rank functions by self-time (µs).
  const nodes = profile.nodes as Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>
  const samples = (profile.samples ?? []) as number[]
  const deltas = (profile.timeDeltas ?? []) as number[]
  const selfTime = new Map<number, number>()
  for (let i = 0; i < samples.length; i++) {
    selfTime.set(samples[i], (selfTime.get(samples[i]) ?? 0) + (deltas[i] ?? 0))
  }
  const byId = new Map<number, typeof nodes[number]>()
  for (const n of nodes) byId.set(n.id, n)

  const ranked = [...selfTime.entries()]
    .map(([id, t]) => {
      const n = byId.get(id)
      const cf = n?.callFrame
      return {
        usec: t,
        name: `${cf?.functionName || '(anon)'} @ ${(cf?.url || '').split('/').slice(-2).join('/')}:${cf?.lineNumber ?? -1}`,
      }
    })
    .sort((a, b) => b.usec - a.usec)
    .slice(0, 40)

  // Frame drops by magnitude
  const dts = frames.map(f => f.dt)
  const stalls = frames
    .map((f, i) => ({ ...f, i }))
    .filter(f => f.dt > 100)
    .sort((a, b) => b.dt - a.dt)
    .slice(0, 10)

  const out = {
    stalls,
    total_frames: frames.length,
    max_dt: Math.max(...dts),
    top_self_time_us: ranked,
  }
  console.log('CPU_PROFILE_REPORT:', JSON.stringify(out, null, 2))
  writeFileSync(join(ART_DIR, 'hybrid-slow-cpuprofile.json'), JSON.stringify(profile))
  writeFileSync(join(ART_DIR, 'hybrid-slow-report.json'), JSON.stringify(out, null, 2))
})
