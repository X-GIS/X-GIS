// GeoJSON path cost measurement — informs the Option A (MVT
// pipeline) vs Option B (surgical) decision raised 2026-05-10.
//
// The audit found:
//   * GeoJSON path: setRawParts → spatial grid → compileSync per
//     tile (synchronous main-thread).
//   * PMTiles path: HTTP + tick() drain → mvt-worker → decodeMvtTile
//     + compileSingleTile (async, frame-budgeted).
//   * Architectural unification via geojson-vt + vt-pbf is feasible
//     (Option B = pipeline insertion at setRawParts) but adds round-
//     trip cost. Whether it's worth it depends on data we don't
//     have: how much of GeoJSON-heavy frame time actually goes to
//     compileSync, and how big the setRawParts encode cost would
//     be.
//
// What this spec measures (using existing CDP profiler infra from
// `_perf-hitch-frame-attribution.spec.ts`):
//
//   1. Cold-load timing: time from `__xgisReady` until any non-
//      background pixel paints. Captures the synchronous compile
//      cascade triggered by setRawParts on first render.
//   2. Interactive pan-zoom hitch: triangle wave zoom 4 → 7 → 4
//      over 6 s on filter_gdp (ne_110m_countries.geojson, ~177
//      features, 725 KB). Per-frame deltas + per-frame CPU profile.
//   3. Per-function attribution INSIDE the worst frame: who
//      dominates? compileSingleTile? decomposeFeatures? GPU upload?
//      Answer decides whether MVT round-trip would help.
//
// Output:
//   test-results/geojson-path-cost.json — full attribution + frame
//   stats. Console table for quick read.

import { test, type Page, type CDPSession } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  parent?: number
}

interface CpuProfile {
  nodes: ProfileNode[]
  startTime: number
  endTime: number
  samples?: number[]
  timeDeltas?: number[]
}

interface FrameTiming {
  ts: number
  dt: number
  elapsed: number
}

async function setup(page: Page, demoId: string) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/demo.html?id=${demoId}#3.0/0/0`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 60_000 },
  )
  // Settle initial GeoJSON compile cascade. ne_110m_countries at
  // first paint takes ~1-3 s on cold cache; 5 s buffer.
  await page.waitForTimeout(5_000)
}

async function recordZoomWithProfile(page: Page, cdp: CDPSession): Promise<{
  profile: CpuProfile
  frames: FrameTiming[]
  perfNowAtProfileStart: number
}> {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
  await cdp.send('Profiler.start')
  const perfNowAtProfileStart = await page.evaluate(() => performance.now())

  const frames = await page.evaluate(async (durationMs: number) => {
    const map = (window as unknown as { __xgisMap?: {
      getCamera: () => { zoom: number };
      invalidate: () => void;
    } }).__xgisMap
    if (!map) throw new Error('__xgisMap missing')
    const cam = map.getCamera()
    const out: FrameTiming[] = []
    return await new Promise<FrameTiming[]>((res) => {
      const t0 = performance.now()
      let last = t0
      const tick = () => {
        const now = performance.now()
        const elapsed = now - t0
        out.push({ ts: now, dt: now - last, elapsed })
        last = now
        if (elapsed >= durationMs) { res(out); return }
        // Triangle wave 4 → 7 → 4 (matches the brief's zoom range
        // for GeoJSON demos which are global at low zoom).
        const phase = elapsed / durationMs
        const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2
        cam.zoom = 4 + tri * 3
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, 6000)

  const stopped = await cdp.send('Profiler.stop') as { profile: CpuProfile }
  await cdp.send('Profiler.disable')
  return { profile: stopped.profile, frames, perfNowAtProfileStart }
}

interface AttributionRow {
  name: string
  url: string
  selfMs: number
  selfPct: number
  callPath: string
}

function attributeWindow(
  profile: CpuProfile,
  windowStartMicros: number,
  windowEndMicros: number,
  topN = 25,
): { rows: AttributionRow[]; totalMs: number } {
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  const byId = new Map<number, ProfileNode>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const n of profile.nodes as any[]) {
    byId.set(n.id, { id: n.id, callFrame: n.callFrame })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const n of profile.nodes as any[]) {
    if (Array.isArray(n.children)) {
      for (const cid of n.children) {
        const child = byId.get(cid)
        if (child) child.parent = n.id
      }
    }
  }
  const path = (id: number, depth = 4): string => {
    const parts: string[] = []
    let cur: number | undefined = id
    for (let i = 0; i < depth && cur; i++) {
      const n = byId.get(cur)
      if (!n) break
      parts.push(n.callFrame.functionName || '(anonymous)')
      cur = n.parent
    }
    return parts.join(' ← ')
  }
  const selfMicros = new Map<number, number>()
  let cursor = profile.startTime
  let total = 0
  for (let i = 0; i < samples.length; i++) {
    const dt = deltas[i] ?? 0
    cursor += dt
    if (cursor < windowStartMicros) continue
    if (cursor > windowEndMicros) break
    const id = samples[i]!
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + dt)
    total += dt
  }
  const rows: AttributionRow[] = []
  for (const [id, micros] of selfMicros) {
    const n = byId.get(id)!
    rows.push({
      name: n.callFrame.functionName || '(anonymous)',
      url: n.callFrame.url || '',
      selfMs: micros / 1000,
      selfPct: total > 0 ? (micros / total) * 100 : 0,
      callPath: path(id, 4),
    })
  }
  rows.sort((a, b) => b.selfMs - a.selfMs)
  return { rows: rows.slice(0, topN), totalMs: total / 1000 }
}

interface ScenarioResult {
  demoId: string
  /** Time from goto → first non-zero `tilesVisible` (ms). Approximates
   *  cold-load wall clock for the GeoJSON path: setRawParts +
   *  initial compileSync cascade + first paint. */
  coldLoadMs: number
  /** Per-frame stats for the 6 s zoom triangle wave (after settle). */
  frames: { count: number; medianMs: number; p95Ms: number; p99Ms: number; worstMs: number }
  /** Worst-frame attribution: top 15 self-time contributors. */
  hitch: { worstMs: number; elapsedAtWorst: number; total: number; top: AttributionRow[] }
  /** Aggregate over the full 6 s. */
  aggregate: { total: number; top: AttributionRow[] }
}

async function runScenario(page: Page, cdp: CDPSession, demoId: string): Promise<ScenarioResult> {
  const t0 = Date.now()
  await setup(page, demoId)
  const coldLoadMs = Date.now() - t0

  const { profile, frames, perfNowAtProfileStart } = await recordZoomWithProfile(page, cdp)
  const settled = frames.slice(2)
  const sorted = [...settled].sort((a, b) => a.dt - b.dt)
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].dt
  const worstFrame = settled.reduce((a, b) => b.dt > a.dt ? b : a, settled[0])

  const msToProfile = (ms: number) => profile.startTime + (ms - perfNowAtProfileStart) * 1000
  const winStart = msToProfile(worstFrame.ts - worstFrame.dt)
  const winEnd = msToProfile(worstFrame.ts)
  const hitch = attributeWindow(profile, winStart, winEnd, 15)
  const aggregate = attributeWindow(profile, profile.startTime, profile.endTime, 20)

  return {
    demoId,
    coldLoadMs,
    frames: {
      count: settled.length,
      medianMs: pct(50),
      p95Ms: pct(95),
      p99Ms: pct(99),
      worstMs: worstFrame.dt,
    },
    hitch: {
      worstMs: worstFrame.dt,
      elapsedAtWorst: worstFrame.elapsed,
      total: hitch.totalMs,
      top: hitch.rows,
    },
    aggregate: {
      total: aggregate.totalMs,
      top: aggregate.rows,
    },
  }
}

/** Cold-start scenario: open the demo at the target hash (high
 *  zoom) WITHOUT a low-zoom settle. Captures setRawParts → first-
 *  visible-tile compile cascade timing — the case where users
 *  share a deep link or refresh at high zoom. */
async function runColdStartAt(page: Page, cdp: CDPSession, demoId: string, hash: string): Promise<{
  demoId: string
  hash: string
  /** ms from goto() to __xgisReady. */
  readyMs: number
  /** ms from __xgisReady until tilesVisible > 0 across any vtSource. */
  firstTileMs: number
  /** Per-frame deltas captured for the 3 s after __xgisReady (no
   *  user interaction). Catches the synchronous compile-cascade
   *  hitch at the deep-link frame. */
  postReadyFrames: number[]
}> {
  await page.setViewportSize({ width: 1280, height: 800 })
  const t0 = Date.now()
  await page.goto(`/demo.html?id=${demoId}${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 60_000 },
  )
  const readyMs = Date.now() - t0

  // Capture per-frame deltas RIGHT after ready — no user input,
  // so any frame variance is purely the GeoJSON compile cascade.
  const tFirstTile = Date.now()
  const frames = await page.evaluate(async (durationMs: number) => {
    const map = (window as unknown as { __xgisMap?: { vtSources: Map<string, unknown>; invalidate: () => void } }).__xgisMap
    if (!map) throw new Error('__xgisMap missing')
    const out: number[] = []
    return await new Promise<number[]>((res) => {
      const t0 = performance.now()
      let last = t0
      let firstTilePerf = -1
      const tick = () => {
        const now = performance.now()
        out.push(now - last)
        last = now
        if (firstTilePerf < 0) {
          let visible = 0
          for (const entry of map.vtSources.values()) {
            const r = entry as { renderer?: { getDrawStats?: () => { tilesVisible: number } } }
            visible += r.renderer?.getDrawStats?.().tilesVisible ?? 0
          }
          if (visible > 0) firstTilePerf = now - t0
        }
        if (now - t0 >= durationMs) {
          res([...out, firstTilePerf])
          return
        }
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, 3000)
  const firstTileWatermark = frames.pop() ?? -1
  const firstTileMs = firstTileWatermark < 0 ? -1 : Math.round(Date.now() - tFirstTile + firstTileWatermark - (3000))

  return { demoId, hash, readyMs, firstTileMs, postReadyFrames: frames }
}

test('GeoJSON path cost — countries (ne_110m, ~177 features, 725 KB)', async ({ page, context }) => {
  test.setTimeout(180_000)
  const cdp = await context.newCDPSession(page)
  const result = await runScenario(page, cdp, 'filter_gdp')

  const out = path.resolve('test-results', 'geojson-path-cost.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(result, null, 2))

  console.log(`\n=== GeoJSON path cost: ${result.demoId} ===`)
  console.log(`  Cold load (goto → __xgisReady + 5 s settle):  ${result.coldLoadMs} ms`)
  console.log(`  Interactive zoom 4→7→4 over 6 s:`)
  console.log(`    median=${result.frames.medianMs.toFixed(1)} ms (${(1000 / result.frames.medianMs).toFixed(0)} fps)`)
  console.log(`    p95=${result.frames.p95Ms.toFixed(1)} ms  p99=${result.frames.p99Ms.toFixed(1)} ms  worst=${result.frames.worstMs.toFixed(0)} ms`)
  console.log(`    frames=${result.frames.count}`)
  console.log(`\n[hitch frame ${result.hitch.worstMs.toFixed(0)} ms @ t+${(result.hitch.elapsedAtWorst / 1000).toFixed(2)} s] top contributors (${result.hitch.total.toFixed(1)} ms attributed):`)
  for (const r of result.hitch.top) {
    if (r.selfMs < 0.3) continue
    const url = r.url ? r.url.split('/').slice(-2).join('/') : ''
    console.log(`  ${r.selfMs.toFixed(2).padStart(6)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(35)} :: ${r.callPath}`)
  }
  console.log(`\n[aggregate ${result.aggregate.total.toFixed(0)} ms] top:`)
  for (const r of result.aggregate.top) {
    if (r.selfMs < 5) continue
    console.log(`  ${r.selfMs.toFixed(0).padStart(5)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(35)}`)
  }
  console.log(`\n[saved] ${out}`)
})

test('GeoJSON cold-start at high zoom — deep link / refresh stress', async ({ page, context }) => {
  test.setTimeout(180_000)
  const cdp = await context.newCDPSession(page)
  // Three deep-link cases over filter_gdp (ne_110m_countries):
  //   * z=8 over Europe (countries dense, polygons visible)
  //   * z=12 over Korea (single country, polygon edge near tile)
  //   * z=14 over Tokyo (zoomed-in, one country edge)
  // PMTiles equivalent (Bright at same z) takes 200-800 ms cold
  // (HTTP + decode). GeoJSON should beat this since data is in
  // memory — but the synchronous compile cascade is the suspect.
  const cases: { hash: string; label: string }[] = [
    { hash: '#8/50/10', label: 'z=8 Europe' },
    { hash: '#12/37.5/127', label: 'z=12 Korea' },
    { hash: '#14/35.68/139.76', label: 'z=14 Tokyo' },
  ]
  console.log(`\n=== GeoJSON cold-start at high zoom (filter_gdp) ===`)
  for (const c of cases) {
    const r = await runColdStartAt(page, cdp, 'filter_gdp', c.hash)
    const sorted = [...r.postReadyFrames].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    const worst = Math.max(...r.postReadyFrames, 0)
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))] ?? 0
    console.log(
      `  [${c.label.padEnd(15)}] ready=${r.readyMs.toString().padStart(4)} ms  ` +
      `firstTile=${r.firstTileMs >= 0 ? r.firstTileMs.toString().padStart(4) + ' ms' : 'never'}  ` +
      `post-ready frames: median=${median.toFixed(1)} p99=${p99.toFixed(1)} worst=${worst.toFixed(0)} (${r.postReadyFrames.length} frames)`,
    )
    // Reset for next case — fresh page state.
    await page.goto('about:blank')
  }
})

test('GeoJSON zoom-in cascade — z=4 → z=10 over 5 s, single direction', async ({ page, context }) => {
  test.setTimeout(180_000)
  const cdp = await context.newCDPSession(page)
  await setup(page, 'filter_gdp')

  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
  await cdp.send('Profiler.start')
  const perfNowAtProfileStart = await page.evaluate(() => performance.now())

  const frames = await page.evaluate(async (durationMs: number) => {
    const map = (window as unknown as { __xgisMap?: {
      getCamera: () => { zoom: number; centerX: number; centerY: number };
      invalidate: () => void;
    } }).__xgisMap
    if (!map) throw new Error('__xgisMap missing')
    const cam = map.getCamera()
    const out: FrameTiming[] = []
    return await new Promise<FrameTiming[]>((res) => {
      const t0 = performance.now()
      let last = t0
      const tick = () => {
        const now = performance.now()
        const elapsed = now - t0
        out.push({ ts: now, dt: now - last, elapsed })
        last = now
        if (elapsed >= durationMs) { res(out); return }
        // Linear ramp 4 → 10 (single direction, no return). Each
        // intermediate z step exposes a fresh visible-tile set with
        // no cached data — the compileSync cascade hits hardest
        // here.
        cam.zoom = 4 + (elapsed / durationMs) * 6
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, 5000)

  const stopped = await cdp.send('Profiler.stop') as { profile: CpuProfile }
  await cdp.send('Profiler.disable')
  const profile = stopped.profile

  const settled = frames.slice(2)
  const sorted = [...settled].sort((a, b) => a.dt - b.dt)
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].dt
  const worstFrame = settled.reduce((a, b) => b.dt > a.dt ? b : a, settled[0])
  const msToProfile = (ms: number) => profile.startTime + (ms - perfNowAtProfileStart) * 1000
  const winStart = msToProfile(worstFrame.ts - worstFrame.dt)
  const winEnd = msToProfile(worstFrame.ts)
  const hitch = attributeWindow(profile, winStart, winEnd, 15)

  console.log(`\n=== GeoJSON zoom-in cascade z=4 → z=10 over 5 s (filter_gdp) ===`)
  console.log(`  median=${pct(50).toFixed(1)} ms (${(1000 / pct(50)).toFixed(0)} fps)  p95=${pct(95).toFixed(1)}  p99=${pct(99).toFixed(1)}  worst=${worstFrame.dt.toFixed(0)} ms @ z=${(4 + (worstFrame.elapsed / 5000) * 6).toFixed(1)}  frames=${settled.length}`)
  console.log(`\n[hitch frame ${worstFrame.dt.toFixed(0)} ms] top contributors (${hitch.totalMs.toFixed(1)} ms attributed):`)
  for (const r of hitch.rows) {
    if (r.selfMs < 0.3) continue
    const url = r.url ? r.url.split('/').slice(-2).join('/') : ''
    console.log(`  ${r.selfMs.toFixed(2).padStart(6)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(35)} :: ${r.callPath}`)
  }
})
