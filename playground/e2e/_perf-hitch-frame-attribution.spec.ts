// S1 worst-frame attribution — automate the next-step the perf-next-
// session brief asked for. The aggregate transition profile shows
// distributed work (VTR.render only 3.7 %, mvt-worker wrapping 6.6 %,
// GC 2.8 %). What the brief flagged: the SINGLE 119-175 ms hitch
// frame in scenario 1 (zoom 10→16→10) is what the user feels — and
// aggregate doesn't tell us what dominates THAT frame.
//
// Approach:
//   1. Animate zoom 10 → 16 → 10 over 6 s (S1 from interactive spec).
//   2. Concurrently record CPU profile via CDP.
//   3. Sample per-frame deltas via rAF (ms each frame).
//   4. Identify the worst frame's [t_start, t_end] in performance.now()
//      time.
//   5. Translate to profile microseconds (anchor on profile.startTime
//      ≈ performance.now() at Profiler.start).
//   6. Filter samples + timeDeltas to entries inside the worst-frame
//      window, aggregate self time per node.
//   7. Print top-N contributors.
//
// Output:
//   - test-results/bright-s1-zoom.cpuprofile (full profile)
//   - test-results/hitch-frame-attribution.json (window stats + top
//     contributors, machine-readable for follow-ups)

import { test, type Page, type CDPSession } from '@playwright/test'
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = fs.readFileSync(resolve(__dirname, '__convert-fixtures/bright.json'), 'utf8')

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  parent?: number
}

interface CpuProfile {
  nodes: ProfileNode[]
  startTime: number   // μs since some V8 epoch
  endTime: number
  samples?: number[]
  timeDeltas?: number[]
}

interface FrameTiming {
  /** rAF tick performance.now() at frame start. */
  ts: number
  /** Frame delta = this frame's render duration (ms). */
  dt: number
  /** Cumulative t (frame index → 0..duration). */
  elapsed: number
}

async function setupBright(page: Page) {
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript((src: string) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'Bright (S1 hitch attr)')
  }, xgis)
  await page.goto('/demo.html?id=__import#10/35.68/139.76/0/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 60_000 },
  )
  await page.waitForTimeout(6_000)  // settle cold-start cascade
}

/** Run S1 (zoom 10→16→10 over 6 s) while collecting per-frame deltas
 *  AND a CDP CPU profile concurrently. The profile's start/end times
 *  are recorded vs performance.now() so we can map sample microseconds
 *  back onto frame windows. */
async function recordS1WithProfile(page: Page, cdp: CDPSession): Promise<{
  profile: CpuProfile
  frames: FrameTiming[]
  /** performance.now() at the instant Profiler.start returned. */
  perfNowAtProfileStart: number
}> {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 })  // 10 kHz
  await cdp.send('Profiler.start')

  // Capture page-side performance.now() RIGHT after start so we can
  // align profile microseconds to frame milliseconds. Page-side and
  // node-side performance.now() share the same timeline (high-res
  // monotonic clock anchored to navigationStart) within Chromium.
  const perfNowAtProfileStart = await page.evaluate(() => performance.now())

  const frames = await page.evaluate(async (durationMs: number) => {
    const map = (window as unknown as { __xgisMap?: {
      getCamera: () => { zoom: number };
      invalidate: () => void;
    } }).__xgisMap
    if (!map) throw new Error('__xgisMap missing')
    const cam = map.getCamera()
    const startCamZoom = 10
    const endCamZoom = 16
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
        // Triangle wave 10 → 16 → 10 (matches S1 in
        // _perf-bright-interactive.spec.ts).
        const phase = elapsed / durationMs
        const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2
        cam.zoom = startCamZoom + tri * (endCamZoom - startCamZoom)
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

/** For one node, walk its callFrame chain via the parent map and
 *  build a "self → parent → ..." function name path so we can tell
 *  apart e.g. native-array-constructor anonymous-leaf samples. */
function nodePath(byId: Map<number, ProfileNode>, id: number, maxDepth = 3): string {
  const parts: string[] = []
  let cur: number | undefined = id
  for (let i = 0; i < maxDepth && cur; i++) {
    const n = byId.get(cur)
    if (!n) break
    const name = n.callFrame.functionName || '(anonymous)'
    parts.push(name)
    cur = n.parent
  }
  return parts.join(' ← ')
}

interface AttributionRow {
  name: string
  url: string
  line: number
  selfMs: number
  selfPct: number
  callPath: string
}

function attributeWindow(
  profile: CpuProfile,
  windowStartMicros: number,
  windowEndMicros: number,
  topN = 25,
): AttributionRow[] {
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  const byId = new Map<number, ProfileNode>()
  // Build parent links from the children-tree V8 emits (each node has
  // an optional `children: number[]`). The flat profile from CDP
  // doesn't expose `parent` directly — we infer it.
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

  const selfMicros = new Map<number, number>()
  let cursor = profile.startTime
  let windowSelfTotal = 0
  for (let i = 0; i < samples.length; i++) {
    const dt = deltas[i] ?? 0
    cursor += dt
    if (cursor < windowStartMicros) continue
    if (cursor > windowEndMicros) break
    const id = samples[i]!
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + dt)
    windowSelfTotal += dt
  }

  const rows: AttributionRow[] = []
  for (const [id, micros] of selfMicros) {
    const n = byId.get(id)!
    rows.push({
      name: n.callFrame.functionName || '(anonymous)',
      url: n.callFrame.url || '',
      line: n.callFrame.lineNumber,
      selfMs: micros / 1000,
      selfPct: windowSelfTotal > 0 ? (micros / windowSelfTotal) * 100 : 0,
      callPath: nodePath(byId, id, 4),
    })
  }
  rows.sort((a, b) => b.selfMs - a.selfMs)
  return rows.slice(0, topN)
}

test('S1 hitch-frame attribution', async ({ page, context }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await setupBright(page)

  const cdp = await context.newCDPSession(page)
  const { profile, frames, perfNowAtProfileStart } = await recordS1WithProfile(page, cdp)

  // Save full profile for DevTools-side inspection if needed.
  const profileOut = path.resolve('test-results', 'bright-s1-zoom.cpuprofile')
  fs.mkdirSync(path.dirname(profileOut), { recursive: true })
  fs.writeFileSync(profileOut, JSON.stringify(profile))

  // Drop first 2 frames (warmup) — same convention as the interactive
  // spec's summarise().
  const settled = frames.slice(2)
  const sorted = [...settled].sort((a, b) => b.dt - a.dt)
  const median = settled.length > 0
    ? [...settled].sort((a, b) => a.dt - b.dt)[Math.floor(settled.length / 2)].dt
    : 0
  const worst = sorted[0]
  const top5Worst = sorted.slice(0, 5)
  // eslint-disable-next-line no-console
  console.log(`\n[S1 frames] count=${settled.length} median=${median.toFixed(1)}ms worst=${worst.dt.toFixed(0)}ms`)
  // eslint-disable-next-line no-console
  console.log('[S1 top-5 worst frames] (dt ms @ elapsed s):')
  for (const f of top5Worst) {
    // eslint-disable-next-line no-console
    console.log(`  ${f.dt.toFixed(0).padStart(4)} ms @ t+${(f.elapsed / 1000).toFixed(2)} s`)
  }

  // Map worst frame's [ts - dt, ts] window into profile micros.
  // perfNowAtProfileStart ≈ profile.startTime / 1000 (both ms-anchored,
  // profile in μs). The shift is small (μs to ms float) but offset is
  // real — we anchor on perfNowAtProfileStart and convert deltas.
  const worstWindowStartMs = worst.ts - worst.dt   // performance.now() at frame start
  const worstWindowEndMs = worst.ts                // at frame end
  // profile.startTime is in μs, at the moment Profiler.start STARTED
  // sampling. perfNowAtProfileStart was captured after Profiler.start
  // returned — the gap is tiny but present. Treat profile.startTime as
  // the μs anchor for perfNowAtProfileStart.
  const profileToMs = (micros: number) =>
    perfNowAtProfileStart + (micros - profile.startTime) / 1000
  const msToProfile = (ms: number) =>
    profile.startTime + (ms - perfNowAtProfileStart) * 1000

  const winStart = msToProfile(worstWindowStartMs)
  const winEnd = msToProfile(worstWindowEndMs)
  // eslint-disable-next-line no-console
  console.log(`\n[hitch window] [${(winStart / 1000).toFixed(0)} μs..${(winEnd / 1000).toFixed(0)} μs] = ${((winEnd - winStart) / 1000).toFixed(1)} ms`)

  const top = attributeWindow(profile, winStart, winEnd, 25)
  // eslint-disable-next-line no-console
  console.log(`\n[hitch attribution] top 25 self-time contributors INSIDE the worst frame:`)
  for (const r of top) {
    if (r.selfMs < 0.1) continue
    const url = r.url ? r.url.split('/').slice(-2).join('/') : ''
    // eslint-disable-next-line no-console
    console.log(
      `  ${r.selfMs.toFixed(2).padStart(6)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(40)} ${url}:${r.line}`,
    )
    // eslint-disable-next-line no-console
    console.log(`    via: ${r.callPath}`)
  }

  // Also dump aggregate top-30 over the entire animation for
  // comparison — same shape the brief was working from.
  const totalRows = attributeWindow(profile, profile.startTime, profile.endTime, 30)
  // eslint-disable-next-line no-console
  console.log(`\n[aggregate top-30] for comparison (full 6 s window):`)
  for (const r of totalRows) {
    if (r.selfMs < 5) continue
    // eslint-disable-next-line no-console
    console.log(
      `  ${r.selfMs.toFixed(0).padStart(5)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(40)}`,
    )
  }

  // Persist machine-readable artifact.
  const attribOut = path.resolve('test-results', 'hitch-frame-attribution.json')
  fs.writeFileSync(attribOut, JSON.stringify({
    settledFrameCount: settled.length,
    medianMs: median,
    worstFrame: { dt: worst.dt, elapsed: worst.elapsed },
    top5WorstFrames: top5Worst.map(f => ({ dt: f.dt, elapsed: f.elapsed })),
    hitchWindow: {
      startPerfNowMs: worstWindowStartMs,
      endPerfNowMs: worstWindowEndMs,
      durationMs: worst.dt,
      profileStartMicros: winStart,
      profileEndMicros: winEnd,
    },
    profileTotalMs: (profile.endTime - profile.startTime) / 1000,
    perfNowAtProfileStart,
    profileStartTime: profile.startTime,
    hitchTopContributors: top,
    aggregateTopContributors: totalRows,
  }, null, 2))
  // eslint-disable-next-line no-console
  console.log(`\n[saved] ${profileOut}\n[saved] ${attribOut}`)
})
