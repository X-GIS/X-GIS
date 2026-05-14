// What's slow at OFM Bright Seoul zoom-in (z≈17)?
// User question: is it labels?
//
// Approach: measure frame timing at #17.85/37.12665/126.92430 in two
// modes — full style + labels-hidden — then attribute the worst frames
// inside each via CDP CPU profile. Labels-off mode reuses the same
// visible=false toggle as the school-fill pixel spec.

import { test, type Page, type CDPSession } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

test.describe.configure({ mode: 'serial' })

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; parent?: number }
interface CpuProfile { nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] }
interface Frame { ts: number; dt: number; elapsed: number }

async function setup(page: Page) {
  await page.goto('/demo.html?id=openfreemap_bright&compute=1#17.85/37.12665/126.92430', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(2000) // settle tile cascade at z=17
}

async function hideLabels(page: Page): Promise<{ hidden: number; total: number }> {
  return await page.evaluate(() => {
    interface ShowCmd { label?: unknown }
    interface M {
      showCommands?: ShowCmd[]
      invalidate?: () => void
    }
    const win = window as unknown as { __xgisDisableLabels?: boolean; __xgisMap?: M }
    win.__xgisDisableLabels = true
    const map = win.__xgisMap
    const total = map?.showCommands?.length ?? 0
    const hidden = (map?.showCommands ?? []).filter(s => s.label !== undefined).length
    map?.invalidate?.()
    return { hidden, total }
  })
}

async function recordWithProfile(page: Page, cdp: CDPSession, durationMs: number, motion: 'idle' | 'pan' | 'zoom'): Promise<{
  profile: CpuProfile
  frames: Frame[]
  perfNowAtStart: number
}> {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
  await cdp.send('Profiler.start')
  const perfNowAtStart = await page.evaluate(() => performance.now())

  const frames = await page.evaluate(async ({ ms, mode }) => {
    interface M {
      camera: { centerX: number; centerY: number; zoom: number }
      invalidate: () => void
    }
    const map = (window as unknown as { __xgisMap?: M }).__xgisMap
    if (!map) throw new Error('__xgisMap missing')
    const startX = map.camera.centerX
    const startY = map.camera.centerY
    const startZ = map.camera.zoom
    const out: Frame[] = []
    return await new Promise<Frame[]>((res) => {
      const t0 = performance.now()
      let last = t0
      const tick = () => {
        const now = performance.now()
        const elapsed = now - t0
        out.push({ ts: now, dt: now - last, elapsed })
        last = now
        if (elapsed >= ms) { res(out); return }
        if (mode === 'pan') {
          const t = elapsed / ms
          map.camera.centerX = startX + t * 30_000
          map.camera.centerY = startY + t * 20_000
        } else if (mode === 'zoom') {
          const phase = elapsed / ms
          const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2
          map.camera.zoom = startZ + tri * 1.5
        }
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, { ms: durationMs, mode: motion })

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

interface Row { name: string; selfMs: number; selfPct: number; callPath: string }

function attribute(profile: CpuProfile, winStart: number, winEnd: number, topN = 20): Row[] {
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
    })
  }
  rows.sort((a, b) => b.selfMs - a.selfMs)
  return rows.slice(0, topN)
}

function summary(frames: Frame[]): { n: number; median: number; p99: number; worst: number; mean: number } {
  const settled = frames.slice(5)
  const ms = settled.map(f => f.dt)
  const sorted = [...ms].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0
  const worst = sorted[sorted.length - 1] ?? 0
  const mean = ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length)
  return { n: settled.length, median, p99, worst, mean }
}

async function runScenario(page: Page, cdp: CDPSession, label: string, motion: 'idle' | 'pan' | 'zoom'): Promise<void> {
  const { profile, frames, perfNowAtStart } = await recordWithProfile(page, cdp, 5000, motion)
  const s = summary(frames)
  // eslint-disable-next-line no-console
  console.log(`\n══ ${label} (${motion}) ══`)
  // eslint-disable-next-line no-console
  console.log(`frames=${s.n}  mean=${s.mean.toFixed(1)}  median=${s.median.toFixed(1)}  p99=${s.p99.toFixed(1)}  worst=${s.worst.toFixed(0)} ms`)

  // Attribute the entire run (not just worst frame — at z=17 idle,
  // many frames are similar so total-window self-time is more
  // informative than picking the one).
  const winStart = profile.startTime
  const winEnd = profile.endTime
  const top = attribute(profile, winStart, winEnd, 15)
  // eslint-disable-next-line no-console
  console.log('top 15 self-time over full 5s:')
  for (const r of top) {
    if (r.selfMs < 5) continue
    // eslint-disable-next-line no-console
    console.log(`  ${r.selfMs.toFixed(0).padStart(5)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(42)} via ${r.callPath}`)
  }

  fs.writeFileSync(path.resolve('test-results', `seoul-${label.replace(/\s+/g, '_')}-${motion}.json`), JSON.stringify({
    label, motion, summary: s, top,
  }, null, 2))
}

test('Seoul z=17 — full style vs labels-off', async ({ page, context }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await setup(page)
  fs.mkdirSync(path.resolve('test-results'), { recursive: true })

  const cdp = await context.newCDPSession(page)

  // ─── A: full style ───────────────────────────────
  await runScenario(page, cdp, 'fullstyle', 'idle')
  await runScenario(page, cdp, 'fullstyle', 'pan')
  await runScenario(page, cdp, 'fullstyle', 'zoom')

  // ─── B: labels off ───────────────────────────────
  const hiddenInfo = await hideLabels(page)
  // eslint-disable-next-line no-console
  console.log(`\n[hidden] ${hiddenInfo.hidden}/${hiddenInfo.total} symbol shows`)
  await page.waitForTimeout(500) // let renderer settle after toggle

  await runScenario(page, cdp, 'labelsoff', 'idle')
  await runScenario(page, cdp, 'labelsoff', 'pan')
  await runScenario(page, cdp, 'labelsoff', 'zoom')
})
