// ═══ Mobile per-pass scoreboard (Phase 0 of the mobile render-pipeline opt) ═══
//
// The mobile performance investigation concluded the cost is NOT render
// resolution (Mapbox/MapLibre/Cesium also render at devicePixelRatio) but the
// MULTI-PASS frame architecture: each frame is a chain of full-screen render
// passes that each load/store the swapchain + depth to main memory. On tile-
// based mobile GPUs (TBDR) every pass boundary flushes on-chip tile memory to
// system RAM and reloads it — the most bandwidth-expensive thing on that
// hardware. DPR=3 then multiplies that bandwidth ~9×.
//
// This spec is the BEFORE/AFTER SCOREBOARD for that work. It runs the Bright
// fixture (multi-layer vector basemap — exercises multiple opaque groups +
// translucent strokes + labels, i.e. the real multi-pass case) at a phone
// viewport (390×844 @ deviceScaleFactor 3) and reports, per scenario:
//
//   • frame-time percentiles (p50/p95/p99/worst) — what the user feels.
//   • PER-PASS CPU encode time via the perf-marks `encoder.pass.${label}`
//     phases — the direct "which passes exist and dominate" attribution
//     (background / opaque-main / opaque[N] / oit / translucent-off[N] /
//     translucent-comp[N] / points / text-overlay / heatmap). This is the
//     primary signal for ranking the pass-count reduction work.
//   • GPU-side breakdown (bg/raster/vt) in ms via the timestamp-query timer
//     (`?gpuprof=1`) — coarse today (sub-pass-0 segmented + the vt ring sums
//     all opaque sub-passes); a per-logical-pass GPU split is a follow-up.
//   • draw-call / triangle counts from map.stats.
//
// It mutates NO runtime render code — pure instrumentation read-out — so it is
// safe to land before any optimization and re-run after each phase to prove
// the win (or a regression). It is NOT a pass/fail gate; it prints a report.
// Run with: cd playground && bunx playwright test _perf-mobile-passes.spec.ts
//
// NOTE: needs a real GPU (CI render-gate runs under SwiftShader, which cannot
// rasterize X-GIS). Run locally on the target-class hardware for real numbers.

import { test, type Page } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(__dirname, '__convert-fixtures/bright.json'), 'utf8')

// Phone-class viewport at 3× DPR — the swapchain renders at 1170×2532, so
// every full-screen pass's load/store moves ~3 MB of colour (×8 B/px for the
// rgba16float OIT targets when active). This is the regime the optimization
// targets.
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })

interface Sample { median: number; p95: number; p99: number; worst: number; frames: number }

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

function summarise(frames: number[]): Sample {
  const t = frames.slice(2) // drop warmup outliers
  return {
    median: pct(t, 50), p95: pct(t, 95), p99: pct(t, 99),
    worst: t.reduce((a, b) => Math.max(a, b), 0), frames: t.length,
  }
}

function reportRow(name: string, s: Sample): string {
  const fps = s.median > 0 ? (1000 / s.median).toFixed(0) : '---'
  return `  ${name.padEnd(28)}  ${s.median.toFixed(1).padStart(6)} ms (${fps.padStart(3)} fps)`
    + `  p95=${s.p95.toFixed(1).padStart(6)}  p99=${s.p99.toFixed(1).padStart(6)}  worst=${s.worst.toFixed(0).padStart(5)}`
    + `  frames=${s.frames}`
}

async function setupPage(page: Page) {
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript((src: string) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'Bright (mobile per-pass)')
    // Enable CPU per-pass phase timing (perf-marks) before the map boots — the
    // `encoder.pass.${label}` marks are what getPhaseAverages() surfaces.
    ;(window as unknown as { __xgisPerfMarks?: boolean }).__xgisPerfMarks = true
  }, xgis)
  // ?gpuprof=1 arms the timestamp-query GPU timer (bg/raster/vt breakdown).
  await page.goto('/demo.html?id=__import&gpuprof=1#10/35.68/139.76/0/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(6_000) // settle cold-start cascade
}

async function runAnimation(page: Page, durationMs: number, updateFn: string): Promise<number[]> {
  return await page.evaluate(async ({ ms, body }) => {
    const map = (window as unknown as { __xgisMap?: {
      getCamera: () => { zoom: number; centerX: number; centerY: number; pitch: number; bearing: number }
      invalidate: () => void
    } }).__xgisMap
    if (!map) throw new Error('__xgisMap not exposed')
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const update = new Function('t', 'cam', 'map', body) as (t: number, c: unknown, m: unknown) => void
    const cam = map.getCamera()
    const frames: number[] = []
    return await new Promise<number[]>((res) => {
      const start = performance.now()
      let last = start
      const tick = () => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        const elapsed = now - start
        if (elapsed >= ms) { res(frames); return }
        update(elapsed / ms, cam, map)
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, { ms: durationMs, body: updateFn })
}

test('Mobile per-pass scoreboard — Bright @ 390×844 DPR3', async ({ page }) => {
  test.setTimeout(120_000)
  await setupPage(page)

  const baseCam = await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: { getCamera: () => { centerX: number; centerY: number; zoom: number } } }).__xgisMap!
    const c = m.getCamera()
    return { x: c.centerX, y: c.centerY, z: c.zoom }
  })

  // Two representative scenarios — a steady zoom and a pitch sweep (pitch
  // amplifies fragment + adds depth-store pressure across opaque groups).
  const zoomFrames = await runAnimation(page, 6000, `
    const phase = t < 0.5 ? t * 2 : (1 - t) * 2;
    cam.zoom = 10 + phase * 4;
    cam.centerX = ${baseCam.x} + phase * 200000;
  `)
  const pitchFrames = await runAnimation(page, 6000, `
    const phase = t < 0.5 ? t * 2 : (1 - t) * 2;
    cam.pitch = phase * 70;
  `)

  // eslint-disable-next-line no-console
  console.log('\n=== Mobile per-pass scoreboard (390×844 DPR3) ===\n')
  // eslint-disable-next-line no-console
  console.log('  scenario                       median (fps)    p95     p99     worst   frames')
  // eslint-disable-next-line no-console
  console.log('  ' + '─'.repeat(95))
  // eslint-disable-next-line no-console
  console.log(reportRow('zoom 10→14→10 + pan', summarise(zoomFrames)))
  // eslint-disable-next-line no-console
  console.log(reportRow('pitch 0→70→0', summarise(pitchFrames)))

  // PER-PASS CPU encode time — the `encoder.pass.${label}` phases are the
  // direct attribution of which render passes exist and how much frame budget
  // each costs. Sorted by per-frame budget (largest first).
  const phaseProfile = await page.evaluate(() => {
    interface API { getPhaseAverages: () => Array<{ name: string; meanMs: number; perFrameMs: number; samples: number }> }
    const api = (window as unknown as { __xgisPerfPhases?: API }).__xgisPerfPhases
    return api?.getPhaseAverages() ?? []
  })
  const passPhases = phaseProfile.filter(p => p.name.startsWith('encoder.pass.'))
  if (passPhases.length > 0) {
    // eslint-disable-next-line no-console
    console.log('\n=== Per-pass CPU encode time (sorted by per-frame budget) ===')
    // eslint-disable-next-line no-console
    console.log('  per-frame  per-call   pass')
    for (const p of passPhases) {
      // eslint-disable-next-line no-console
      console.log(`  ${p.perFrameMs.toFixed(3).padStart(8)}   ${p.meanMs.toFixed(3).padStart(7)}   ${p.name.replace('encoder.pass.', '')}`)
    }
  }
  // Top-level frame phases (prep / encode / submit) for context.
  const framePhases = phaseProfile.filter(p => p.name.startsWith('frame.'))
  if (framePhases.length > 0) {
    // eslint-disable-next-line no-console
    console.log('\n=== Frame phase budget (CPU) ===')
    for (const p of framePhases) {
      // eslint-disable-next-line no-console
      console.log(`  ${p.perFrameMs.toFixed(3).padStart(8)} ms  ${p.name}`)
    }
  }

  // GPU-side breakdown (bg/raster/vt) in ms — coarse, but isolates the GPU
  // share of the frame from the CPU encode share above.
  const gpu = await page.evaluate(() => {
    interface T { getBreakdown: () => Record<string, number[]> }
    const m = (window as unknown as { __xgisMap?: { gpuTimer?: T } }).__xgisMap
    const b = m?.gpuTimer?.getBreakdown?.() ?? {}
    const out: Record<string, { p50: number; p95: number }> = {}
    for (const [k, ns] of Object.entries(b)) {
      const ms = ns.map(n => n / 1e6).sort((a, z) => a - z)
      if (ms.length === 0) continue
      out[k] = { p50: ms[Math.floor(ms.length * 0.5)]!, p95: ms[Math.floor(ms.length * 0.95)]! }
    }
    return out
  })
  const gpuKeys = Object.keys(gpu)
  if (gpuKeys.length > 0) {
    // eslint-disable-next-line no-console
    console.log('\n=== GPU timestamp breakdown (ms) ===')
    for (const k of gpuKeys) {
      // eslint-disable-next-line no-console
      console.log(`  ${k.padEnd(10)} p50=${gpu[k]!.p50.toFixed(3).padStart(7)}  p95=${gpu[k]!.p95.toFixed(3).padStart(7)}`)
    }
  } else {
    // eslint-disable-next-line no-console
    console.log('\n[gpu-timer] no samples (timestamp-query unsupported on this adapter, or ?gpuprof not armed)')
  }

  // Scene draw stats for context (how much geometry the passes are pushing).
  const stats = await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: { stats?: { drawCalls: number; triangles: number; lines: number; tilesVisible: number } } }).__xgisMap
    return m?.stats ?? null
  })
  if (stats) {
    // eslint-disable-next-line no-console
    console.log(`\n=== Scene draw stats ===\n  drawCalls=${stats.drawCalls} triangles=${stats.triangles} lines=${stats.lines} tilesVisible=${stats.tilesVisible}`)
  }
})
