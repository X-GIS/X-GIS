// CPU profile DURING the #10 drag-pan (user-report repro).
//
// iter-160 harness pinned the bug numerically: at Liberty Seoul
// z17 pitch68 bearing285 a 5 s rAF pan-drag shows pan p95=107 ms
// (~2× the 50 ms target) while static-frame stats are bounded
// (tiles=228, tris=96 k, draws=217). The lag is per-frame CPU/
// upload churn during the drag, not per-pixel GPU cost or tile
// explosion. This spec captures a CPU profile WHILE the drag is
// running so the top-N hot functions reflect drag-time work
// rather than idle steady-state (the existing
// _perf-bright-cpuprofile only profiles a static frame).
//
// Output:
//   - test-results/merc-high-pitch-drag.cpuprofile (load in
//     Chrome DevTools Performance tab for the flame graph)
//   - stdout top-30 self-time hot functions over the drag window
//
// memory: project_high_pitch_thermal_2026_05_11 + project_tile_
// pitch_matrix (do NOT blind-patch this class — read the
// flame/list FIRST, then surgically attack the dominant cost).

import { test, type Page, type CDPSession } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = fs.readFileSync(resolve(__dirname, '__convert-fixtures/liberty.json'), 'utf8')

const SEOUL = { lon: 126.9776, lat: 37.53772 }
const HASH = `#17.30/${SEOUL.lat}/${SEOUL.lon}/285.0/68.1`

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
}
interface CpuProfile {
  nodes: ProfileNode[]
  startTime: number
  endTime: number
  samples?: number[]
  timeDeltas?: number[]
}

function topHotFunctions(
  profile: CpuProfile,
  topN = 30,
): Array<{
  name: string
  url: string
  line: number
  selfMs: number
  selfPct: number
}> {
  const selfMicros = new Map<number, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i]!
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + (deltas[i] ?? 0))
  }
  const totalMicros = profile.endTime - profile.startTime
  return profile.nodes
    .map((n) => ({
      name: n.callFrame.functionName || '(anonymous)',
      url: n.callFrame.url || '',
      line: n.callFrame.lineNumber,
      selfMs: (selfMicros.get(n.id) ?? 0) / 1000,
      selfPct: totalMicros > 0 ? ((selfMicros.get(n.id) ?? 0) / totalMicros) * 100 : 0,
    }))
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, topN)
}

async function recordProfile(cdp: CDPSession, durationMs: number): Promise<CpuProfile> {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 }) // 10 kHz
  await cdp.send('Profiler.start')
  await new Promise((r) => setTimeout(r, durationMs))
  const stopped = (await cdp.send('Profiler.stop')) as { profile: CpuProfile }
  await cdp.send('Profiler.disable')
  return stopped.profile
}

async function setup(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 })
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript((src: string) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'Liberty (#10 drag CPU)')
  }, xgis)
  await page.goto(`/demo.html?id=__import${HASH}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 60_000 },
  )
  await page.waitForTimeout(4_000)
}

test('#10 Liberty Seoul z17 pitch68 — CPU profile DURING drag-pan', async ({ page, context }) => {
  test.setTimeout(180_000)
  await setup(page)

  const cdp = await context.newCDPSession(page)
  const PROFILE_MS = 5000

  // Kick off the rAF pan-drag inside the page WITHOUT awaiting, so the
  // CDP profile records WHILE it runs. setCenter every rAF; small lon
  // delta (~200 m) mimics a finger drag without re-zooming.
  const panPromise = page.evaluate(
    async (args: { lon: number; lat: number; durMs: number }) => {
      const m = (
        window as unknown as {
          __xgisMap?: {
            setCenter: (lng: number, lat: number) => void
          }
        }
      ).__xgisMap
      if (!m) return
      const t0 = performance.now()
      await new Promise<void>((resolve) => {
        const step = (now: number) => {
          const t = Math.min(1, (now - t0) / args.durMs)
          const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
          const dLon = 0.002 * ease
          const dLat = 0.001 * ease
          m.setCenter(args.lon + dLon, args.lat + dLat)
          if (t >= 1) return resolve()
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })
    },
    { lon: SEOUL.lon, lat: SEOUL.lat, durMs: PROFILE_MS },
  )

  // Record profile during the drag. Both end together.
  const profile = await recordProfile(cdp, PROFILE_MS)
  await panPromise

  const outDir = path.resolve('test-results')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, 'merc-high-pitch-drag.cpuprofile')
  fs.writeFileSync(outPath, JSON.stringify(profile))

  console.log(`\n[profile] saved: ${outPath} (Chrome DevTools → Performance → load)`)

  const hot = topHotFunctions(profile, 30)

  console.log(
    `\n[hot] top 30 by self time over ${PROFILE_MS}ms DURING drag (#10 Liberty z17 pitch68):`,
  )
  for (const r of hot) {
    if (r.selfMs < 1) continue
    const url = r.url ? r.url.split('/').slice(-2).join('/') : ''

    console.log(
      `  ${r.selfMs.toFixed(1).padStart(7)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(40)} ${url}:${r.line}`,
    )
  }
})
