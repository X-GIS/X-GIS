// User report: OFM Bright at Tokyo, zoom 9 → 10 transition, stutter
// attributed to measureText. Verify with CDP CPU profile attribution
// inside the worst frames of the zoom motion.
//
// What we expect to see in a profile if measureText is the culprit:
//   - `measureText` or `ctx.measureText` showing as self-time top-N
//   - OR `rasterize` / `glyph-rasterizer.ts:142` lighting up
//   - OR `computeSDF` (the distance-transform pass that follows the
//     measure + fillText)
//
// Pretext (chenglou/pretext) optimises multiline TEXT LAYOUT, not
// single-glyph measurement. Our only measureText callsite is
// glyph-rasterizer.ts:142 — one call per (fontKey, codepoint) pair
// then cached. If THIS is the bottleneck, pretext doesn't apply
// directly; the cost is on the cache-miss path (new POI labels at
// z=10 trigger fresh glyph SDFs). The fix would be different —
// pre-warm the glyph atlas, throttle SDF generation, or offload SDF
// computation to a worker. This spec measures the reality.

import { test, type Page, type CDPSession } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

test.describe.configure({ mode: 'serial' })

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; parent?: number }
interface CpuProfile { nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] }
interface Frame { ts: number; dt: number; elapsed: number }

async function setup(page: Page) {
  await page.goto('/demo.html?id=openfreemap_bright#9/35.68/139.76', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // Settle initial cascade. The actual stutter happens DURING the
  // zoom motion below — we want pre-zoom glyph atlas already populated
  // for z=9 so the z=10 transition is the focused event.
  await page.waitForTimeout(3_000)
}

async function recordZoomWithProfile(page: Page, cdp: CDPSession): Promise<{
  profile: CpuProfile
  frames: Frame[]
  perfNowAtStart: number
}> {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 }) // 10 kHz
  await cdp.send('Profiler.start')
  const perfNowAtStart = await page.evaluate(() => performance.now())

  const frames = await page.evaluate(async () => {
    interface M { camera: { zoom: number }; invalidate: () => void }
    const map = (window as unknown as { __xgisMap?: M }).__xgisMap
    if (!map) throw new Error('__xgisMap missing')
    const startZoom = map.camera.zoom
    const out: Frame[] = []
    return await new Promise<Frame[]>(resolve => {
      const t0 = performance.now()
      let last = t0
      const tick = () => {
        const now = performance.now()
        const elapsed = now - t0
        out.push({ ts: now, dt: now - last, elapsed })
        last = now
        // 3 seconds: z=9 → z=10 linearly. Slow enough that glyph
        // atlas misses spread across frames; the user's "stutter"
        // shows up as 1-2 worst frames.
        if (elapsed >= 3000) { resolve(out); return }
        map.camera.zoom = startZoom + (elapsed / 3000) * 1.0
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  })

  const stopped = await cdp.send('Profiler.stop') as { profile: CpuProfile }
  await cdp.send('Profiler.disable')
  return { profile: stopped.profile, frames, perfNowAtStart }
}

function nodePath(byId: Map<number, ProfileNode>, id: number, max = 4): string {
  const parts: string[] = []
  let cur: number | undefined = id
  for (let i = 0; i < max && cur; i++) {
    const n = byId.get(cur)
    if (!n) break
    parts.push(n.callFrame.functionName || '(anon)')
    cur = n.parent
  }
  return parts.join(' ← ')
}

interface Row { name: string; selfMs: number; selfPct: number; callPath: string; url: string; line: number }

function attribute(profile: CpuProfile, winStart: number, winEnd: number, topN = 25): Row[] {
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  const byId = new Map<number, ProfileNode>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const n of profile.nodes as any[]) byId.set(n.id, { id: n.id, callFrame: n.callFrame })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const n of profile.nodes as any[]) {
    if (Array.isArray(n.children)) for (const cid of n.children) {
      const child = byId.get(cid)
      if (child) child.parent = n.id
    }
  }
  const selfMicros = new Map<number, number>()
  let cursor = profile.startTime
  let total = 0
  for (let i = 0; i < samples.length; i++) {
    const dt = deltas[i] ?? 0
    cursor += dt
    if (cursor < winStart) continue
    if (cursor > winEnd) break
    const id = samples[i]!
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + dt)
    total += dt
  }
  const rows: Row[] = []
  for (const [id, m] of selfMicros) {
    const n = byId.get(id)!
    rows.push({
      name: n.callFrame.functionName || '(anon)',
      selfMs: m / 1000,
      selfPct: total > 0 ? (m / total) * 100 : 0,
      callPath: nodePath(byId, id, 4),
      url: n.callFrame.url ? n.callFrame.url.split('/').slice(-2).join('/') : '',
      line: n.callFrame.lineNumber,
    })
  }
  rows.sort((a, b) => b.selfMs - a.selfMs)
  return rows.slice(0, topN)
}

test('Tokyo OFM Bright z=9→10 stutter — CPU attribution', async ({ page, context }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await setup(page)
  const cdp = await context.newCDPSession(page)
  const { profile, frames, perfNowAtStart } = await recordZoomWithProfile(page, cdp)

  fs.mkdirSync(path.resolve('test-results'), { recursive: true })
  fs.writeFileSync(path.resolve('test-results', 'tokyo-zoom-9-10.cpuprofile'), JSON.stringify(profile))

  const settled = frames.slice(3)
  const sorted = [...settled].sort((a, b) => b.dt - a.dt)
  const med = settled.length > 0
    ? [...settled].sort((a, b) => a.dt - b.dt)[Math.floor(settled.length / 2)]!.dt
    : 0
  const worst = sorted[0]!
  const top5 = sorted.slice(0, 5)

  // eslint-disable-next-line no-console
  console.log(`\n══ Tokyo OFM Bright z=9 → z=10 (3 s) ══`)
  // eslint-disable-next-line no-console
  console.log(`Frames ${settled.length}  median ${med.toFixed(1)} ms  worst ${worst.dt.toFixed(0)} ms (@ z=${(9 + worst.elapsed / 3000).toFixed(2)})`)
  // eslint-disable-next-line no-console
  console.log('Top-5 worst frames:')
  for (const f of top5) {
    // eslint-disable-next-line no-console
    console.log(`  ${f.dt.toFixed(0).padStart(4)} ms  @ z=${(9 + f.elapsed / 3000).toFixed(2)}  t+${(f.elapsed / 1000).toFixed(2)} s`)
  }

  // Attribute the WORST single frame.
  const msToProfile = (ms: number) => profile.startTime + (ms - perfNowAtStart) * 1000
  const winStart = msToProfile(worst.ts - worst.dt)
  const winEnd = msToProfile(worst.ts)
  // eslint-disable-next-line no-console
  console.log(`\n[Worst frame: ${worst.dt.toFixed(1)} ms] top 20 self-time contributors:`)
  for (const r of attribute(profile, winStart, winEnd, 20)) {
    if (r.selfMs < 0.1) continue
    // eslint-disable-next-line no-console
    console.log(`  ${r.selfMs.toFixed(2).padStart(6)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(36)} ${r.url}:${r.line}`)
    // eslint-disable-next-line no-console
    console.log(`    via: ${r.callPath}`)
  }

  // Top-5 worst frames combined.
  const allStart = msToProfile(top5[0]!.ts - top5[0]!.dt)
  const allEnd = msToProfile(top5[top5.length - 1]!.ts)
  // eslint-disable-next-line no-console
  console.log(`\n[Top-5 worst frames combined] top 15:`)
  for (const r of attribute(profile, allStart, allEnd, 15)) {
    if (r.selfMs < 1) continue
    // eslint-disable-next-line no-console
    console.log(`  ${r.selfMs.toFixed(1).padStart(6)} ms  ${r.name.padEnd(36)} ${r.url}:${r.line}`)
  }

  // Aggregate top-30 over the full 3-second zoom.
  // eslint-disable-next-line no-console
  console.log(`\n[Full 3 s aggregate] top 20 self-time:`)
  for (const r of attribute(profile, profile.startTime, profile.endTime, 20)) {
    if (r.selfMs < 5) continue
    // eslint-disable-next-line no-console
    console.log(`  ${r.selfMs.toFixed(0).padStart(5)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(36)} ${r.url}:${r.line}`)
  }
})
