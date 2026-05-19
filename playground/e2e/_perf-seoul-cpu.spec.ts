// CPU profile capture during steady-state Seoul Liberty render.
// User 2026-05-19: "런타임 렌더콜에서 추가 성능 최적화가 필요".
// z14 (label-dense) 27ms p50 + z16-p60 (building-heavy) 41ms p50.
// This spec captures hot-functions during a 4s window so the
// dominant time-sink is identifiable.

import { test, type CDPSession } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__perf-seoul-cpu__')
mkdirSync(OUT, { recursive: true })

interface ProfNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
}
interface CpuProfile {
  nodes: ProfNode[]
  startTime: number
  endTime: number
  samples?: number[]
  timeDeltas?: number[]
}

function topHot(profile: CpuProfile, topN = 30): Array<{
  name: string; url: string; line: number; selfMs: number; selfPct: number
}> {
  const selfMicros = new Map<number, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i]!
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + (deltas[i] ?? 0))
  }
  const totalUs = profile.endTime - profile.startTime
  const rows = profile.nodes.map(n => ({
    name: n.callFrame.functionName || '(anon)',
    url: n.callFrame.url || '',
    line: n.callFrame.lineNumber,
    selfMs: (selfMicros.get(n.id) ?? 0) / 1000,
    selfPct: totalUs > 0 ? ((selfMicros.get(n.id) ?? 0) / totalUs) * 100 : 0,
  }))
  rows.sort((a, b) => b.selfMs - a.selfMs)
  return rows.slice(0, topN)
}

const CELLS: Array<{ slug: string; zoom: number; pitch: number }> = [
  { slug: 'z14-p0',  zoom: 14, pitch: 0 },
  { slug: 'z16-p60', zoom: 16, pitch: 60 },
]

for (const cell of CELLS) {
  test(`cpu profile seoul liberty ${cell.slug}`, async ({ page, context }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1280, height: 800 })

    await page.goto(
      `/compare.html?style=openfreemap-liberty#${cell.zoom}/37.5172/126.9810/0/${cell.pitch}`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 60_000 },
    )
    await page.waitForTimeout(5_000)  // settle uploads

    // Continuous render loop during profile (camera animation triggers
    // every frame to be re-rendered, surfacing hot path).
    await page.evaluate(() => {
      const m = (window as unknown as { __xgisMap?: { camera: { bearing: number }; invalidate?: () => void } }).__xgisMap
      if (!m) return
      let bearing = 0
      const loop = () => {
        bearing = (bearing + 0.3) % 360
        m.camera.bearing = bearing
        m.invalidate?.()
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    })

    const cdp: CDPSession = await context.newCDPSession(page)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 })  // 10 kHz
    await cdp.send('Profiler.start')
    await new Promise(r => setTimeout(r, 4_000))
    const result = await cdp.send('Profiler.stop') as { profile: CpuProfile }
    await cdp.send('Profiler.disable')
    const profile = result.profile

    writeFileSync(join(OUT, `${cell.slug}.cpuprofile`), JSON.stringify(profile))
    const hot = topHot(profile, 30)
    const lines: string[] = []
    lines.push(`[cpu ${cell.slug}] top 30 self time (4s window):`)
    for (const r of hot) {
      if (r.selfMs < 1) continue
      const u = r.url ? r.url.split('/').slice(-2).join('/') : ''
      lines.push(`  ${r.selfMs.toFixed(1).padStart(7)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  `
        + `${r.name.padEnd(40)} ${u}:${r.line}`)
    }
    writeFileSync(join(OUT, `${cell.slug}.hot.txt`), lines.join('\n'))
    // eslint-disable-next-line no-console
    console.log('\n' + lines.join('\n'))
  })
}
