// Comprehensive fixture audit — runs each of the 57 fixtures through a
// pan + zoom-in + zoom-out + bearing-rotate interaction, collecting:
//   - console errors and warnings (page-level)
//   - frame time p95 / max (rAF-sampled during the interaction)
//   - writeBuffer call count + total/peak bytes (device.queue hook)
//   - final missedTiles + any pending uploads
// Produces a ranked report so the worst offenders are visible at a
// glance, plus the full per-fixture telemetry on disk.

import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART_DIR = join(HERE, '__fixture-audit__')
mkdirSync(ART_DIR, { recursive: true })

// Benign noise that shows up on nearly every page and isn't actionable.
const NOISE_RE =
  /powerPreference|ignoreHTTPSErrors|\[vite\]|Monaco|DevTools|UNKNOWN touch|countries-sample|Failed to load resource|FLICKER/

interface FixtureResult {
  id: string
  durationMs: number
  fps: number
  p50: number
  p95: number
  max: number
  drops16: number
  drops33: number
  drops100: number
  errors: string[]
  warns: string[]
  wbTotal: number
  wbPeakCalls: number
  wbTotalBytes: number
  wbPeakKB: number
  pendingVT: boolean
  pendingRaster: boolean
}

test('audit all fixtures under interaction', async ({ page }) => {
  // ≤ 8 s per fixture × 60 ≈ 8 min worst case. Cap at 15 min.
  test.setTimeout(900_000)
  await page.setViewportSize({ width: 1200, height: 700 })

  // Pull the fixture id list at runtime from the playground bundle so
  // the audit stays in sync with demos.ts without us re-hardcoding.
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const fixtureIds = await page.evaluate(async () => {
    const mod = await import('/src/demos.ts')
    const demos = (mod as unknown as { DEMOS: Record<string, { tag: string }> }).DEMOS
    return Object.entries(demos).filter(([, d]) => d.tag === 'fixture').map(([id]) => id)
  })

  const results: FixtureResult[] = []

  for (const id of fixtureIds) {
    const errors: string[] = []
    const warns: string[] = []
    const onConsole = (m: import('@playwright/test').ConsoleMessage): void => {
      const t = m.text()
      if (NOISE_RE.test(t)) return
      if (m.type() === 'error') errors.push(t)
      else if (m.type() === 'warning') warns.push(t)
    }
    const onPageError = (e: Error): void => errors.push(`[pageerror] ${e.message}`)
    page.on('console', onConsole)
    page.on('pageerror', onPageError)

    try {
      await page.goto(`/demo.html?id=${id}&e2e=1`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(
        () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
        null, { timeout: 15_000 },
      )
      await page.waitForTimeout(500) // initial settle

      // Install writeBuffer hook on the freshly-mounted device.
      await page.evaluate(() => {
        const win = window as unknown as {
          __xgisMap?: { ctx?: { device: GPUDevice } }
          __perf?: { count: number; bytes: number; peakCalls: number; peakBytes: number }
        }
        const device = win.__xgisMap?.ctx?.device
        if (!device) throw new Error('no device')
        const orig = device.queue.writeBuffer.bind(device.queue)
        win.__perf = { count: 0, bytes: 0, peakCalls: 0, peakBytes: 0 }
        device.queue.writeBuffer = ((buf, off, data, dOff, sz) => {
          win.__perf!.count++
          const len = sz ?? (data as ArrayBufferView).byteLength ?? 0
          win.__perf!.bytes += len
          return orig(buf, off, data as BufferSource, dOff as number, sz as number)
        }) as typeof device.queue.writeBuffer
      })

      // Run scripted interaction: pan ± 60°, zoom 0→6→2, bearing 0→45°.
      // Captures per-frame dt + writeBuffer churn so we can detect stalls
      // that are invisible at the aggregate frame-time summary.
      const frames = await page.evaluate(() => new Promise<{
        samples: { t: number; dt: number; wbCount: number; wbBytes: number }[]
        pendingVT: boolean
        pendingRaster: boolean
      }>((resolve) => {
        const R = 6378137
        const win = window as unknown as {
          __xgisMap?: {
            camera: { centerX: number; centerY: number; zoom: number; bearing: number; pitch: number }
            vtSources?: Map<string, { renderer: { hasPendingUploads(): boolean } }>
            rasterRenderer?: { hasPendingLoads(): boolean }
          }
          __perf?: { count: number; bytes: number }
        }
        const map = win.__xgisMap!
        const startZoom = map.camera.zoom
        const startX = map.camera.centerX
        const samples: { t: number; dt: number; wbCount: number; wbBytes: number }[] = []
        const t0 = performance.now()
        let lastT = t0, lastCount = 0, lastBytes = 0
        const TOTAL_MS = 4500

        function tick() {
          const now = performance.now()
          const tRel = now - t0
          const c = win.__perf!.count, b = win.__perf!.bytes
          samples.push({ t: tRel, dt: now - lastT, wbCount: c - lastCount, wbBytes: b - lastBytes })
          lastT = now; lastCount = c; lastBytes = b

          // Scripted phases: 0–1s pan+zoom in, 1–2.5s zoom out, 2.5–3.5s
          // pan back, 3.5–4.5s bearing rotation. All continuous so we
          // exercise interpolation + dirty-flag wake-ups at every tick.
          const u = tRel / TOTAL_MS
          if (u < 0.25) {
            // Pan 60° east while zooming to z=startZoom+4
            map.camera.centerX = startX + (60 * u * 4) * Math.PI / 180 * R
            map.camera.zoom = startZoom + u * 4 * 4
          } else if (u < 0.55) {
            // Zoom back out
            map.camera.zoom = (startZoom + 4) - (u - 0.25) / 0.3 * 4
          } else if (u < 0.78) {
            // Pan back west, further than start (through antimeridian)
            const pu = (u - 0.55) / 0.23
            map.camera.centerX = startX + (60 - 150 * pu) * Math.PI / 180 * R
          } else {
            // Bearing rotation with slight pitch so oblique-only code paths fire
            const bu = (u - 0.78) / 0.22
            map.camera.bearing = bu * 45
            map.camera.pitch = bu * 30
          }

          if (tRel >= TOTAL_MS) {
            resolve({
              samples,
              pendingVT: [...(map.vtSources?.values() ?? [])].some(v => v.renderer.hasPendingUploads()),
              pendingRaster: map.rasterRenderer?.hasPendingLoads() ?? false,
            })
          } else {
            requestAnimationFrame(tick)
          }
        }
        requestAnimationFrame(tick)
      }))

      // Drop the first 2 samples — rAF boundary noise.
      const fs = frames.samples.slice(2)
      const dts = fs.map(s => s.dt).sort((a, b) => a - b)
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
      const pct = (xs: number[], p: number) => xs[Math.floor(xs.length * p)] ?? 0
      const wbCounts = fs.map(s => s.wbCount)
      const wbBytesArr = fs.map(s => s.wbBytes)

      results.push({
        id,
        durationMs: sum(dts),
        fps: Math.round(1000 / (sum(dts) / dts.length)),
        p50: +pct(dts, 0.5).toFixed(1),
        p95: +pct(dts, 0.95).toFixed(1),
        max: +(dts[dts.length - 1] ?? 0).toFixed(1),
        drops16: dts.filter(d => d > 16.7).length,
        drops33: dts.filter(d => d > 33.4).length,
        drops100: dts.filter(d => d > 100).length,
        errors: [...new Set(errors)],
        warns: [...new Set(warns)],
        wbTotal: sum(wbCounts),
        wbPeakCalls: Math.max(0, ...wbCounts),
        wbTotalBytes: sum(wbBytesArr),
        wbPeakKB: +((Math.max(0, ...wbBytesArr)) / 1024).toFixed(1),
        pendingVT: frames.pendingVT,
        pendingRaster: frames.pendingRaster,
      })
    } catch (err) {
      results.push({
        id, durationMs: 0, fps: 0, p50: 0, p95: 0, max: 0,
        drops16: 0, drops33: 0, drops100: 0,
        errors: [`[load-failed] ${(err as Error).message}`, ...errors],
        warns,
        wbTotal: 0, wbPeakCalls: 0, wbTotalBytes: 0, wbPeakKB: 0,
        pendingVT: false, pendingRaster: false,
      })
    }

    page.off('console', onConsole)
    page.off('pageerror', onPageError)
  }

  // Rankings
  const byErr = results.filter(r => r.errors.length > 0)
  const byWarn = results.filter(r => r.warns.length > 0)
  const worstMax = [...results].sort((a, b) => b.max - a.max).slice(0, 10)
  const worstP95 = [...results].sort((a, b) => b.p95 - a.p95).slice(0, 10)
  const biggestWB = [...results].sort((a, b) => b.wbPeakKB - a.wbPeakKB).slice(0, 10)

  const summary = {
    total: results.length,
    withErrors: byErr.length,
    withWarnings: byWarn.length,
    dropsOver100: results.filter(r => r.drops100 > 0).length,
    dropsOver33: results.filter(r => r.drops33 > 0).length,
    pendingVT: results.filter(r => r.pendingVT).length,
    pendingRaster: results.filter(r => r.pendingRaster).length,
    errors: byErr.map(r => ({ id: r.id, count: r.errors.length, first: r.errors[0] })),
    warns: byWarn.map(r => ({ id: r.id, count: r.warns.length, first: r.warns[0] })),
    worstMax: worstMax.map(r => ({ id: r.id, max: r.max, p95: r.p95, drops100: r.drops100 })),
    worstP95: worstP95.map(r => ({ id: r.id, p95: r.p95, max: r.max, drops33: r.drops33 })),
    biggestWB: biggestWB.map(r => ({ id: r.id, peakKB: r.wbPeakKB, peakCalls: r.wbPeakCalls })),
  }

  console.log('AUDIT_SUMMARY:', JSON.stringify(summary, null, 2))
  writeFileSync(join(ART_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
  writeFileSync(join(ART_DIR, 'full.json'), JSON.stringify(results, null, 2))
})
