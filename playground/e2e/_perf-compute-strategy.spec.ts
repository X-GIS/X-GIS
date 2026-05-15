// A/B measurement for the match() kernel lowering strategy.
//
// compute-gen.ts emits one of two WGSL shapes for `match(get(field), …)`:
//
//   • if-chain  — sequential `if (cls == K0) …  else if (cls == K1) …`
//                 (arms < MATCH_LUT_THRESHOLD; default 16)
//   • LUT       — `const LUT: array<vec4<f32>, N>(…); color = LUT[id];`
//                 (arms ≥ threshold)
//
// The threshold is conservative — the comment cited CPU-style branch
// prediction, which doesn't apply on GPU warps where divergence is the
// real cost. This spec measures the actual crossover by running the
// SAME scene with the LUT threshold flipped between runs and comparing
// median per-frame GPU `vt` segment time.
//
// continent-match is the right test fixture: 7 arms on the `CONTINENT`
// field, 250 features (Natural Earth countries), one fill draw per
// feature. Below the default threshold so the baseline uses if-chain;
// override = 4 forces LUT for the same scene.
//
// Requires `?gpuprof=1` so the device opts in to the timestamp-query
// feature. The runtime's GPUTimer feeds `getBreakdown()` through to
// `window.__xgisMap.gpuTimer` for inspection.

import { test, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

test.describe.configure({ mode: 'serial' })

interface Sample {
  vt: number
  total: number
}

async function setup(page: Page, lutThreshold: number) {
  await page.addInitScript((threshold: number) => {
    ;(globalThis as { __XGIS_MATCH_LUT_THRESHOLD?: number }).__XGIS_MATCH_LUT_THRESHOLD = threshold
  }, lutThreshold)
  await page.goto('/demo.html?id=continent_match&gpuprof=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // Settle past cold-start cascade. GPU timer needs a few frames for
  // its readback ring to start producing samples (RING_SIZE=3).
  await page.waitForTimeout(1500)
}

/** Drive a sustained pan so the camera moves through tile boundaries
 *  + feature draws update each frame. Pulls breakdown samples from the
 *  GPUTimer ring directly — same data path the production stats panel
 *  consumes. Returns one Sample per frame the timer actually produced
 *  readings for (most frames; some pre-roll won't have samples yet). */
async function measure(page: Page, durationMs: number): Promise<Sample[]> {
  return await page.evaluate(async (ms: number) => {
    interface M {
      camera: { centerX: number; centerY: number }
      invalidate: () => void
      gpuTimer: { getBreakdown(): Record<string, number[]>; resetTimings(): void } | null
    }
    interface Sample { vt: number; total: number }
    const map = (window as unknown as { __xgisMap?: M }).__xgisMap
    if (!map) throw new Error('__xgisMap missing')
    const timer = map.gpuTimer
    if (!timer) throw new Error('gpuTimer missing — was ?gpuprof=1 set?')
    timer.resetTimings()

    const startX = map.camera.centerX
    const samples: Sample[] = []
    return await new Promise<Sample[]>(resolve => {
      const t0 = performance.now()
      const tick = () => {
        const elapsed = performance.now() - t0
        if (elapsed >= ms) {
          // Grab everything the timer has accumulated.
          const b = timer.getBreakdown()
          const vt = b.vt ?? b.total ?? []
          const total = b.total ?? vt
          const n = Math.min(vt.length, total.length)
          for (let i = 0; i < n; i++) {
            samples.push({ vt: vt[i]!, total: total[i]! })
          }
          resolve(samples)
          return
        }
        map.camera.centerX = startX + Math.sin(elapsed / 800) * 200_000
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, durationMs)
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

function summarise(samples: Sample[]): { n: number; median: number; p95: number; mean: number } {
  if (samples.length === 0) return { n: 0, median: 0, p95: 0, mean: 0 }
  const vt = samples.map(s => s.vt).filter(v => v > 0)
  if (vt.length === 0) return { n: samples.length, median: 0, p95: 0, mean: 0 }
  return {
    n: vt.length,
    median: pct(vt, 50),
    p95: pct(vt, 95),
    mean: vt.reduce((a, b) => a + b, 0) / vt.length,
  }
}

test('continent-match GPU strategy A/B — if-chain vs LUT', async ({ browser }) => {
  test.setTimeout(180_000)

  const runs: Array<{ label: string; threshold: number; samples: Sample[] }> = []
  for (const cfg of [
    { label: 'if-chain (threshold 16, default)', threshold: 16 },
    { label: 'LUT     (threshold 4,  forced)',  threshold: 4 },
  ]) {
    // Fresh context per run — guarantees the compute pipeline is recompiled
    // with the new threshold (compute-gen reads the override at emit time,
    // which happens once per fresh scene load).
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    await setup(page, cfg.threshold)
    const samples = await measure(page, 6_000)
    runs.push({ label: cfg.label, threshold: cfg.threshold, samples })
    await ctx.close()
  }

  const lines: string[] = []
  lines.push('\n══ continent-match · compute kernel strategy A/B ══')
  lines.push('Scene: 7-arm match(CONTINENT) on Natural Earth countries (~250 features)')
  lines.push('Metric: GPU `vt` segment time per frame (timestamp-query inside-passes)')
  lines.push('')
  lines.push(`${'Threshold'.padEnd(38)} ${'frames'.padStart(8)} ${'median μs'.padStart(11)} ${'p95 μs'.padStart(11)} ${'mean μs'.padStart(11)}`)
  for (const run of runs) {
    const s = summarise(run.samples)
    // gpu-timer returns nanoseconds — convert to μs for readability.
    const toUs = (ns: number) => ns / 1000
    lines.push(`${run.label.padEnd(38)} ${String(s.n).padStart(8)} `
      + `${toUs(s.median).toFixed(1).padStart(11)} `
      + `${toUs(s.p95).toFixed(1).padStart(11)} `
      + `${toUs(s.mean).toFixed(1).padStart(11)}`)
  }
  const sIf  = summarise(runs[0]!.samples)
  const sLut = summarise(runs[1]!.samples)
  if (sIf.median > 0 && sLut.median > 0) {
    const delta = ((sLut.median - sIf.median) / sIf.median) * 100
    const verdict = delta < -5 ? 'LUT WINS' : delta > 5 ? 'if-chain WINS' : 'within noise'
    lines.push('')
    lines.push(`Δ median: LUT vs if-chain = ${delta > 0 ? '+' : ''}${delta.toFixed(1)} %  →  ${verdict}`)
  } else {
    lines.push('')
    lines.push('Δ: insufficient samples (gpu timing returned 0 — check ?gpuprof=1 support)')
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'))

  fs.mkdirSync(path.resolve('test-results'), { recursive: true })
  fs.writeFileSync(
    path.resolve('test-results', 'compute-strategy-ab.json'),
    JSON.stringify({
      runs: runs.map(r => ({
        label: r.label, threshold: r.threshold,
        ...summarise(r.samples),
        rawVtNs: r.samples.map(s => s.vt),
      })),
    }, null, 2),
  )
})
