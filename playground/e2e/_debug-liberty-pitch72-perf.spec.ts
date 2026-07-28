// Frame-drop + persistent-[FLICKER] probe at the reported OFM Liberty camera:
//   #16.00/51.50466/-0.11813/60.0/72.4
//
// pitch 72.4 is near-horizon, so the visible tile set is far larger than the
// nadir case the tile budget was tuned against. The probe holds that camera
// still (no interaction) and records, per frame, the terms
// `getTileLoadDiagnostic()` decomposes [FLICKER] into — needed / missed /
// gpuUnique / catalogCached / catalogLoading / uploadQueued / gpuCap — next to
// the frame interval, so "frames drop" and "tiles keep missing" can be read
// against each other instead of guessed at.
//
// Every console warning is captured too: [FLICKER] itself, and the arena-oom
// warn the upload path emits when a tile cannot claim GPU arena space.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installOfflineProxy } from './helpers/offline-proxy'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__debug-liberty-pitch72__')
mkdirSync(OUT, { recursive: true })

const HASH = process.env.PERF_HASH ?? '#16.00/51.50466/-0.11813/60.0/72.4'
const STYLE = process.env.PERF_STYLE ?? 'openfreemap-liberty'
const SAMPLE_MS = Number(process.env.PERF_SAMPLE_MS ?? 20_000)

interface Sample {
  t: number
  dt: number
  diag: Record<string, Record<string, number>>
  tilesVisible: number
  drawCalls: number
}

test(`liberty pitch-72 perf probe ${HASH}`, async ({ page }) => {
  test.setTimeout(300_000)
  const warnings: string[] = []
  page.on('console', (m) => {
    const t = m.text()
    if (/FLICKER|arena-oom|oom|budget|evict|drop/i.test(t)) warnings.push(`[${m.type()}] ${t}`)
  })
  await installOfflineProxy(page, { cacheDir: join(HERE, '__net-cache__') })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/compare.html?style=${STYLE}${HASH}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 120_000 },
  )
  // Let the initial compile burst settle so the grace window is spent and any
  // surviving [FLICKER] is the persistent kind the report describes.
  await page.waitForTimeout(8_000)

  const samples: Sample[] = await page.evaluate(async (ms) => {
    interface M {
      getStats?: () => { tilesVisible: number; drawCalls: number }
      getTileLoadDiagnostic: () => Record<string, Record<string, number>>
    }
    const map = (window as unknown as { __xgisMap: M }).__xgisMap
    const out: Sample[] = []
    let prev = performance.now()
    const t0 = prev
    await new Promise<void>((resolve) => {
      const tick = () => {
        const now = performance.now()
        const s = map.getStats?.()
        out.push({
          t: now - t0,
          dt: now - prev,
          diag: map.getTileLoadDiagnostic(),
          tilesVisible: s?.tilesVisible ?? -1,
          drawCalls: s?.drawCalls ?? -1,
        })
        prev = now
        if (now - t0 >= ms) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return out
  }, SAMPLE_MS)

  const dts = samples.slice(1).map((s) => s.dt)
  dts.sort((a, b) => a - b)
  const pct = (p: number) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))]
  const report = {
    hash: HASH,
    style: STYLE,
    frames: dts.length,
    frameMs: {
      p50: +pct(0.5).toFixed(2),
      p95: +pct(0.95).toFixed(2),
      p99: +pct(0.99).toFixed(2),
      max: +dts[dts.length - 1].toFixed(2),
    },
    over16ms: dts.filter((d) => d > 16.7).length,
    over33ms: dts.filter((d) => d > 33).length,
    first: samples[0]?.diag,
    last: samples[samples.length - 1]?.diag,
    tilesVisible: samples[samples.length - 1]?.tilesVisible,
    drawCalls: samples[samples.length - 1]?.drawCalls,
    warnings: warnings.slice(0, 40),
    warningCount: warnings.length,
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(OUT, 'samples.json'), JSON.stringify(samples))
  console.warn('[perf]', JSON.stringify(report, null, 2))
  expect(samples.length).toBeGreaterThan(0)
})
