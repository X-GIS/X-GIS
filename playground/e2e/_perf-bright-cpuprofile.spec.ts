// CPU-profile + hot-function breakdown for Bright at z=14 Tokyo.
// Mirrors `_pmtiles-perf.spec.ts` but for the converted Bright
// style — pinpoints the residual ~90 ms / frame that the
// per-frame upload cap (4bcf106) didn't fully recover.
//
// Output:
//   - .cpuprofile in test-results/ (drag onto DevTools Performance tab)
//   - Top-30 hot functions by self time, printed to test stdout

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
}
interface CpuProfile {
  nodes: ProfileNode[]
  startTime: number
  endTime: number
  samples?: number[]
  timeDeltas?: number[]
}

function topHotFunctions(profile: CpuProfile, topN = 30) {
  const selfMicros = new Map<number, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i]!
    const dt = deltas[i] ?? 0
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + dt)
  }
  const totalMicros = (profile.endTime - profile.startTime)
  const rows = profile.nodes.map(n => ({
    name: n.callFrame.functionName || '(anonymous)',
    url: n.callFrame.url || '',
    line: n.callFrame.lineNumber,
    selfMs: (selfMicros.get(n.id) ?? 0) / 1000,
    selfPct: totalMicros > 0 ? ((selfMicros.get(n.id) ?? 0) / totalMicros) * 100 : 0,
  }))
  rows.sort((a, b) => b.selfMs - a.selfMs)
  return rows.slice(0, topN)
}

async function recordProfile(cdp: CDPSession, durationMs: number): Promise<CpuProfile> {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 })  // 10 kHz
  await cdp.send('Profiler.start')
  await new Promise(r => setTimeout(r, durationMs))
  const stopped = await cdp.send('Profiler.stop') as { profile: CpuProfile }
  await cdp.send('Profiler.disable')
  return stopped.profile
}

async function waitForXgisReady(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 60_000 },
  )
}

test('Bright pitch=0 z=14 Tokyo — CPU profile + hot functions', async ({ page, context }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  const xgis = convertMapboxStyle(fixture)

  await page.addInitScript((src: string) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'Bright (perf)')
  }, xgis)

  await page.goto('/demo.html?id=__import#14/35.68/139.76/0/0', { waitUntil: 'domcontentloaded' })
  await waitForXgisReady(page)
  await page.waitForTimeout(5_000)  // settle initial uploads

  const cdp = await context.newCDPSession(page)
  const PROFILE_MS = 4000
  const profile = await recordProfile(cdp, PROFILE_MS)

  const outPath = path.resolve('test-results', 'bright-pitch0-z14.cpuprofile')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(profile))
  // eslint-disable-next-line no-console
  console.log(`\n[profile] saved: ${outPath} (drag onto DevTools Performance tab)`)

  // eslint-disable-next-line no-console
  console.log(`\n[hot] top 30 by self time over ${PROFILE_MS}ms (Bright pitch=0 z=14):`)
  const hot = topHotFunctions(profile, 30)
  for (const r of hot) {
    if (r.selfMs < 1) continue
    const url = r.url ? r.url.split('/').slice(-2).join('/') : ''
    // eslint-disable-next-line no-console
    console.log(`  ${r.selfMs.toFixed(1).padStart(7)} ms (${r.selfPct.toFixed(1).padStart(5)}%)  ${r.name.padEnd(40)} ${url}:${r.line}`)
  }
})
