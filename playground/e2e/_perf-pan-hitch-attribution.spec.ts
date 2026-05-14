// Pan-hitch attribution — find what dominates the 50-70ms worst frame
// observed during diagonal pan on OFM Bright (per _perf-worker-receive
// spec). The drain counter proved worker receive ≠ bottleneck; the
// spike consistently lands at idx ~20-27 with 0 tile resolves. CPU
// profile inside the worst-frame window will say what does.
//
// Pattern copied from _perf-hitch-frame-attribution.spec.ts (S1 zoom
// hitch). Only setup + motion shape differ.

import { test, type Page, type CDPSession } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

test.describe.configure({ mode: 'serial' })

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

interface FrameTiming { ts: number; dt: number; elapsed: number }

async function setupBright(page: Page) {
  await page.goto('/demo.html?id=openfreemap_bright&compute=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // Short settle so the pan can trigger fresh tile loads — long settle
  // drained the worker queue in the receive spec; we want the same
  // motion conditions here.
  await page.waitForTimeout(800)
}

async function recordPanWithProfile(page: Page, cdp: CDPSession): Promise<{
  profile: CpuProfile
  frames: FrameTiming[]
  perfNowAtProfileStart: number
}> {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 }) // 10 kHz
  await cdp.send('Profiler.start')
  const perfNowAtProfileStart = await page.evaluate(() => performance.now())

  const frames = await page.evaluate(async (durationMs: number) => {
    interface M {
      camera: { centerX: number; centerY: number }
      invalidate: () => void
    }
    const map = (window as unknown as { __xgisMap?: M }).__xgisMap
    if (!map) throw new Error('__xgisMap missing')
    const startX = map.camera.centerX
    const startY = map.camera.centerY
    const dx = 800_000, dy = 400_000
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
        const t = elapsed / durationMs
        map.camera.centerX = startX + t * dx
        map.camera.centerY = startY + t * dy
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, 8000)

  const stopped = await cdp.send('Profiler.stop') as { profile: CpuProfile }
  await cdp.send('Profiler.disable')
  return { profile: stopped.profile, frames, perfNowAtProfileStart }
}

function nodePath(byId: Map<number, ProfileNode>, id: number, maxDepth = 4): string {
  const parts: string[] = []
  let cur: number | undefined = id
  for (let i = 0; i < maxDepth && cur; i++) {
    const n = byId.get(cur)
    if (!n) break
    parts.push(n.callFrame.functionName || '(anonymous)')
    cur = n.parent
  }
  return parts.join(' ← ')
}

interface AttributionRow { name: string; url: string; line: number; selfMs: number; selfPct: number; callPath: string }

function attributeWindow(profile: CpuProfile, winStart: number, winEnd: number, topN = 25): AttributionRow[] {
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  const byId = new Map<number, ProfileNode>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const n of profile.nodes as any[]) byId.set(n.id, { id: n.id, callFrame: n.callFrame })
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
  const rows: AttributionRow[] = []
  for (const [id, micros] of selfMicros) {
    const n = byId.get(id)!
    rows.push({
      name: n.callFrame.functionName || '(anonymous)',
      url: n.callFrame.url || '',
      line: n.callFrame.lineNumber,
      selfMs: micros / 1000,
      selfPct: total > 0 ? (micros / total) * 100 : 0,
      callPath: nodePath(byId, id, 4),
    })
  }
  rows.sort((a, b) => b.selfMs - a.selfMs)
  return rows.slice(0, topN)
}

test('OFM Bright pan-hitch attribution', async ({ page, context }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await setupBright(page)
  const cdp = await context.newCDPSession(page)
  const { profile, frames, perfNowAtProfileStart } = await recordPanWithProfile(page, cdp)

  const profileOut = path.resolve('test-results', 'pan-hitch.cpuprofile')
  fs.mkdirSync(path.dirname(profileOut), { recursive: true })
  fs.writeFileSync(profileOut, JSON.stringify(profile))

  const settled = frames.slice(2)
  const sorted = [...settled].sort((a, b) => b.dt - a.dt)
  const median = settled.length > 0
    ? [...settled].sort((a, b) => a.dt - b.dt)[Math.floor(settled.length / 2)]!.dt
    : 0
  const worst = sorted[0]!
  const top5 = sorted.slice(0, 5)
  // eslint-disable-next-line no-console
  console.log(`\n[pan] frames=${settled.length} median=${median.toFixed(1)}ms worst=${worst.dt.toFixed(0)}ms`)
  // eslint-disable-next-line no-console
  console.log('[pan] top-5 worst frames:')
  for (const f of top5) {
    // eslint-disable-next-line no-console
    console.log(`  ${f.dt.toFixed(0).padStart(4)} ms @ t+${(f.elapsed / 1000).toFixed(2)} s`)
  }

  const msToProfile = (ms: number) => profile.startTime + (ms - perfNowAtProfileStart) * 1000
  const winStart = msToProfile(worst.ts - worst.dt)
  const winEnd = msToProfile(worst.ts)
  // eslint-disable-next-line no-console
  console.log(`\n[hitch] window ${worst.dt.toFixed(1)} ms`)

  const top = attributeWindow(profile, winStart, winEnd, 25)
  // eslint-disable-next-line no-console
  console.log(`[hitch] top 25 self-time inside worst frame:`)
  for (const r of top) {
    if (r.selfMs < 0.1) continue
    const url = r.url ? r.url.split('/').slice(-2).join('/') : ''
    // eslint-disable-next-line no-console
    console.log(`  ${r.selfMs.toFixed(2).padStart(6)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(40)} ${url}:${r.line}`)
    // eslint-disable-next-line no-console
    console.log(`    via: ${r.callPath}`)
  }

  // Also attribute the top-3 worst frames combined — pattern check.
  const winsCombinedStart = msToProfile(top5[0]!.ts - top5[0]!.dt)
  const winsCombinedEnd = msToProfile(top5[2]!.ts)
  // eslint-disable-next-line no-console
  console.log(`\n[hitch top-3 combined] attribution:`)
  const topCombined = attributeWindow(profile, winsCombinedStart, winsCombinedEnd, 20)
  for (const r of topCombined) {
    if (r.selfMs < 0.5) continue
    // eslint-disable-next-line no-console
    console.log(`  ${r.selfMs.toFixed(2).padStart(6)} ms  ${r.name.padEnd(40)} via ${r.callPath}`)
  }

  fs.writeFileSync(path.resolve('test-results', 'pan-hitch-attribution.json'), JSON.stringify({
    medianMs: median,
    worst: { dt: worst.dt, elapsed: worst.elapsed },
    top5Worst: top5.map(f => ({ dt: f.dt, elapsed: f.elapsed })),
    hitchTop: top,
  }, null, 2))
})
