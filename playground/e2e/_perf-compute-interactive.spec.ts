// ═══════════════════════════════════════════════════════════════════
// Interactive perf — compute=1 + smooth zoom / pan
// ═══════════════════════════════════════════════════════════════════
//
// Per user request: drive REAL smooth interactions (zoom in/out, pan)
// with `?compute=1` flag active, measure per-frame timing, and dump
// the hot frames + percentile distribution to the console.
//
// Output:
//   - Per-scenario p50 / p95 / p99 / worst frame ms
//   - Top-5 slow-frame breakdown (the frames that produce visible
//     stutter — single hitch in 60 frames feels like a freeze)
//
// Three scenarios, all on continent_match.xgis (8-arm match() fill →
// compute kernel actually dispatches on every tile):
//
//   1. Zoom in (z=3 → z=8) + out — every LOD jump triggers fetch +
//      decode + compute-kernel dispatch
//   2. Pan east 500 km at z=6 — sustained sub-tile generation +
//      compute kernel firing on each new tile
//   3. Combined zoom + pan — worst case (both inflate work)

import { test, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

interface Sample {
  median: number
  p95: number
  p99: number
  worst: number
  worstFrames: { idx: number; ms: number }[]
  frames: number
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

function summarise(frames: number[]): Sample {
  const t = frames.slice(2) // drop 2 warmup frames
  const sorted = [...t].sort((a, b) => b - a)
  const worstFrames = sorted.slice(0, 5).map(ms => {
    const idx = t.indexOf(ms)
    return { idx, ms }
  })
  return {
    median: pct(t, 50),
    p95: pct(t, 95),
    p99: pct(t, 99),
    worst: t.reduce((a, b) => Math.max(a, b), 0),
    worstFrames,
    frames: t.length,
  }
}

function reportRow(name: string, s: Sample): string {
  const fps = s.median > 0 ? (1000 / s.median).toFixed(0) : '---'
  return `  ${name.padEnd(28)}  ${s.median.toFixed(1).padStart(6)} ms (${fps.padStart(3)} fps)`
    + `  p95=${s.p95.toFixed(1).padStart(6)}  p99=${s.p99.toFixed(1).padStart(6)}  worst=${s.worst.toFixed(0).padStart(5)}`
    + `  frames=${s.frames}`
}

async function setupPage(page: Page, demoId: string, compute: boolean) {
  const url = `/demo.html?id=${demoId}${compute ? '&compute=1' : ''}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // Settle initial cascade.
  await page.waitForTimeout(4_000)
}

async function runAnimation(
  page: Page,
  durationMs: number,
  updateFn: string,
): Promise<number[]> {
  return await page.evaluate(async ({ ms, body }) => {
    const map = (window as unknown as { __xgisMap?: {
      camera: { zoom: number; centerX: number; centerY: number; pitch: number; bearing: number };
      invalidate: () => void;
    } }).__xgisMap
    if (!map) throw new Error('__xgisMap not exposed')
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const update = new Function('t', 'cam', 'map', body) as (t: number, c: unknown, m: unknown) => void

    const cam = map.camera
    const frames: number[] = []
    return await new Promise<number[]>((resolve) => {
      const start = performance.now()
      let last = start
      const tick = () => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        const elapsed = now - start
        if (elapsed >= ms) { resolve(frames); return }
        const t = elapsed / ms
        update(t, cam, map)
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, { ms: durationMs, body: updateFn })
}

test('continent_match interactive perf — compute=1 vs compute=0', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  // ── Two passes: compute=0 baseline, compute=1 candidate ──
  const results: Array<{ label: string; s1: Sample; s2: Sample; s3: Sample }> = []

  for (const compute of [false, true]) {
    await setupPage(page, 'continent_match', compute)

    const baseCam = await page.evaluate(() => {
      const m = (window as unknown as { __xgisMap?: { camera: { centerX: number; centerY: number; zoom: number } } }).__xgisMap!
      return { x: m.camera.centerX, y: m.camera.centerY }
    })

    // Scenario 1: zoom in/out triangle 3 → 8 → 3
    const z1 = await runAnimation(page, 6000, `
      const phase = t < 0.5 ? t * 2 : (1 - t) * 2;
      cam.zoom = 3 + phase * 5;
    `)
    const s1 = summarise(z1)

    // Scenario 2: pan east 500km at z=6
    const z2 = await runAnimation(page, 6000, `
      const phase = t < 0.5 ? t * 2 : (1 - t) * 2;
      cam.zoom = 6;
      cam.centerX = ${baseCam.x} + phase * 500000;
    `)
    const s2 = summarise(z2)

    // Scenario 3: combined zoom + pan
    const z3 = await runAnimation(page, 6000, `
      const phase = t < 0.5 ? t * 2 : (1 - t) * 2;
      cam.zoom = 4 + phase * 4;
      cam.centerX = ${baseCam.x} + phase * 300000;
    `)
    const s3 = summarise(z3)

    results.push({
      label: compute ? 'compute=1' : 'compute=0',
      s1, s2, s3,
    })
  }

  // ── Report ──
  // eslint-disable-next-line no-console
  console.log('\n══════ continent_match interactive perf ══════\n')
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`── ${r.label} ──`)
    // eslint-disable-next-line no-console
    console.log(reportRow('zoom triangle 3→8→3', r.s1))
    // eslint-disable-next-line no-console
    console.log(reportRow('pan east 500km z=6', r.s2))
    // eslint-disable-next-line no-console
    console.log(reportRow('zoom + pan combined', r.s3))
    // eslint-disable-next-line no-console
    console.log('  worst frames (idx ms):',
      [...r.s1.worstFrames, ...r.s2.worstFrames, ...r.s3.worstFrames]
        .sort((a, b) => b.ms - a.ms).slice(0, 5)
        .map(f => `${f.idx}=${f.ms.toFixed(0)}ms`).join('  '))
    // eslint-disable-next-line no-console
    console.log()
  }

  // Comparison delta
  const c0 = results.find(r => r.label === 'compute=0')!
  const c1 = results.find(r => r.label === 'compute=1')!
  // eslint-disable-next-line no-console
  console.log('── compute=1 delta vs compute=0 ──')
  const deltaRow = (name: string, a: Sample, b: Sample) => {
    const dMedian = b.median - a.median
    const dP99 = b.p99 - a.p99
    const dWorst = b.worst - a.worst
    return `  ${name.padEnd(28)}  median Δ=${dMedian.toFixed(1).padStart(6)}  p99 Δ=${dP99.toFixed(1).padStart(6)}  worst Δ=${dWorst.toFixed(0).padStart(5)}`
  }
  // eslint-disable-next-line no-console
  console.log(deltaRow('zoom triangle 3→8→3', c0.s1, c1.s1))
  // eslint-disable-next-line no-console
  console.log(deltaRow('pan east 500km z=6', c0.s2, c1.s2))
  // eslint-disable-next-line no-console
  console.log(deltaRow('zoom + pan combined', c0.s3, c1.s3))
})

test('OFM Bright interactive perf — compute=1', async ({ page }) => {
  // OFM Bright doesn't activate compute kernels (no match() in paint),
  // but exercising it under compute=1 confirms the no-compute code
  // paths add no per-frame overhead. This catches regressions where
  // the registry / dispatch wrappers introduce hidden cost on the
  // mainstream production path.
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await setupPage(page, 'openfreemap_bright', true)

  const baseCam = await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: { camera: { centerX: number; centerY: number; zoom: number } } }).__xgisMap!
    return { x: m.camera.centerX, y: m.camera.centerY }
  })

  const z1 = await runAnimation(page, 6000, `
    const phase = t < 0.5 ? t * 2 : (1 - t) * 2;
    cam.zoom = 10 + phase * 5;
  `)
  const z2 = await runAnimation(page, 6000, `
    const phase = t < 0.5 ? t * 2 : (1 - t) * 2;
    cam.zoom = 12;
    cam.centerX = ${baseCam.x} + phase * 200000;
  `)
  const s1 = summarise(z1)
  const s2 = summarise(z2)
  // eslint-disable-next-line no-console
  console.log('\n══════ OFM Bright + compute=1 ══════\n')
  // eslint-disable-next-line no-console
  console.log(reportRow('zoom triangle 10→15→10', s1))
  // eslint-disable-next-line no-console
  console.log(reportRow('pan east 200km z=12', s2))
  // eslint-disable-next-line no-console
  console.log('  worst frames:',
    [...s1.worstFrames, ...s2.worstFrames]
      .sort((a, b) => b.ms - a.ms).slice(0, 5)
      .map(f => `${f.idx}=${f.ms.toFixed(0)}ms`).join('  '))
  // eslint-disable-next-line no-console
  console.log()
})
