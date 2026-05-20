// Interactive perf scenarios — closer to how real users exercise the
// renderer than the steady-state pitch sweep we've been measuring.
// Three scenarios, all on the OpenFreeMap Bright fixture:
//
//   1. Smooth zoom in (z=10→16) then out (z=16→10)
//   2. Smooth zoom + pan (z=10→14 + east pan, then reverse)
//   3. Smooth pitch 0→80°→0
//
// Each runs for ~6 seconds with per-frame camera updates driven from
// the test page. We report median + p95 + p99 + worst frame time —
// p99 / worst capture the stutter the user actually feels (a single
// 200 ms hitch in 60 frames feels like a freeze even though median
// reports 8 ms).

import { test, type Page } from '@playwright/test'
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(__dirname, '__convert-fixtures/bright.json'), 'utf8')

interface Sample {
  median: number
  p95: number
  p99: number
  worst: number
  frames: number
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

function summarise(frames: number[]): Sample {
  // Drop first 2 frames (warmup outliers from animation start)
  const t = frames.slice(2)
  return {
    median: pct(t, 50),
    p95: pct(t, 95),
    p99: pct(t, 99),
    worst: t.reduce((a, b) => Math.max(a, b), 0),
    frames: t.length,
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
    sessionStorage.setItem('__xgisImportLabel', 'Bright (interactive perf)')
  }, xgis)
  await page.goto('/demo.html?id=__import#10/35.68/139.76/0/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // Settle initial cascade so we're measuring the animation itself,
  // not cold-start tile decode + upload.
  await page.waitForTimeout(6_000)
}

/** Run a per-frame animation on the in-page map. `update(t)` receives
 *  normalised time in [0, 1] over `durationMs` and should mutate the
 *  camera; we call `map.invalidate()` afterward. Returns one frame
 *  delta per rAF tick. */
async function runAnimation(
  page: Page,
  durationMs: number,
  updateFn: string,  // a serialisable JS body that takes (t: number, cam, map)
): Promise<number[]> {
  return await page.evaluate(async ({ ms, body }) => {
    const map = (window as unknown as { __xgisMap?: {
      getCamera: () => { zoom: number; centerX: number; centerY: number; pitch: number; bearing: number };
      invalidate: () => void;
    } }).__xgisMap
    if (!map) throw new Error('__xgisMap not exposed')
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const update = new Function('t', 'cam', 'map', body) as (t: number, c: unknown, m: unknown) => void

    const cam = map.getCamera()
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

// iter-240 — drive the alloc-counter during a representative
// interactive scenario. Logs the top per-site counts. The drag
// path re-runs label collision + shape per frame, so sites that
// cache-out at idle WILL fire here.
async function captureAllocProfile(page: Page, body: string, ms: number = 3000): Promise<Record<string, number>> {
  return await page.evaluate(async ({ src, dur }) => {
    interface API {
      setEnabled: (on: boolean) => void
      snapshotAllocProfile: () => Record<string, number>
    }
    const api = (window as unknown as { __xgisAllocProfile?: API }).__xgisAllocProfile
    if (!api) return {}
    interface M {
      getCamera: () => { zoom: number; centerX: number; centerY: number; pitch: number; bearing: number }
      invalidate: () => void
    }
    const map = (window as unknown as { __xgisMap?: M }).__xgisMap
    if (!map) return {}
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const update = new Function('t', 'cam', 'map', src) as (t: number, c: unknown, m: unknown) => void
    const cam = map.getCamera()
    api.setEnabled(true)
    api.snapshotAllocProfile()  // discard pre-window state
    await new Promise<void>(resolve => {
      const start = performance.now()
      const tick = () => {
        const elapsed = performance.now() - start
        if (elapsed >= dur) { resolve(); return }
        update(elapsed / dur, cam, map)
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const delta = api.snapshotAllocProfile()
    api.setEnabled(false)
    return delta
  }, { src: body, dur: ms })
}

test('Bright interactive perf — 3 scenarios', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await setupPage(page)

  // Capture initial Mercator center for relative pan animations.
  const baseCam = await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: { getCamera: () => { centerX: number; centerY: number; zoom: number } } }).__xgisMap!
    const c = m.getCamera()
    return { x: c.centerX, y: c.centerY, z: c.zoom }
  })
  // eslint-disable-next-line no-console
  console.log(`\n[setup] Tokyo z=${baseCam.z} centerX=${baseCam.x.toFixed(0)} centerY=${baseCam.y.toFixed(0)}`)

  // ── Scenario 1: smooth zoom in → out ──
  // Triangle wave 10 → 16 → 10 over 6 s. Each LOD jump triggers a tile
  // selection / fetch / decode / upload cascade — this captures the
  // stutter during fast zoom.
  const z1 = await runAnimation(page, 6000, `
    const phase = t < 0.5 ? t * 2 : (1 - t) * 2;  // 0..1..0
    cam.zoom = 10 + phase * 6;                     // 10..16..10
  `)
  const s1 = summarise(z1)

  // ── Scenario 2: pan + zoom in/out ──
  // Move east 200 km while zooming z=10→14; reverse on the way back.
  // Tests fetch priority and sub-tile decode pacing under combined
  // motion (camera fetches MUST cancel stale tiles outside the new
  // visible set or they pile up and stall).
  const z2 = await runAnimation(page, 6000, `
    const phase = t < 0.5 ? t * 2 : (1 - t) * 2;  // 0..1..0
    cam.zoom = 10 + phase * 4;
    cam.centerX = ${baseCam.x} + phase * 200000;  // 200 km east
  `)
  const s2 = summarise(z2)

  // ── Scenario 3: pitch sweep 0 → 80 → 0 ──
  // Where the SSE selector + horizon cull earn their keep. Without
  // them the user-reported "1 fps freeze" lived here.
  const z3 = await runAnimation(page, 6000, `
    const phase = t < 0.5 ? t * 2 : (1 - t) * 2;  // 0..1..0
    cam.pitch = phase * 80;
  `)
  const s3 = summarise(z3)

  // eslint-disable-next-line no-console
  console.log('\n=== Bright interactive perf ===\n')
  // eslint-disable-next-line no-console
  console.log('  scenario                       median (fps)    p95     p99     worst   frames')
  // eslint-disable-next-line no-console
  console.log('  ' + '─'.repeat(95))
  // eslint-disable-next-line no-console
  console.log(reportRow('1. zoom 10→16→10',         s1))
  // eslint-disable-next-line no-console
  console.log(reportRow('2. zoom 10→14→10 + pan',    s2))
  // eslint-disable-next-line no-console
  console.log(reportRow('3. pitch 0→80→0',           s3))

  // iter-256 (Plan AAA C.3) — phase timing breakdown. Identifies
  // CPU bottleneck (frame.prep vs frame.encode vs frame.submit)
  // so the NEXT perf attack is data-driven, not a guess.
  const phaseProfile = await page.evaluate(() => {
    interface API { getPhaseAverages: () => Array<{ name: string; meanMs: number; samples: number }> }
    const api = (window as unknown as { __xgisPerfPhases?: API }).__xgisPerfPhases
    return api?.getPhaseAverages() ?? []
  })
  if (phaseProfile.length > 0) {
    // eslint-disable-next-line no-console
    console.log('\n=== Phase timing breakdown (rolling 60-frame mean) ===')
    for (const p of phaseProfile) {
      // eslint-disable-next-line no-console
      console.log(`  ${p.meanMs.toFixed(2).padStart(7)} ms  ${p.name}  (${p.samples} samples)`)
    }
  }

  // iter-240 (Plan AAA C.2) — alloc profile during interactive
  // path. Drag/zoom drives re-shape + re-collision per frame, so
  // sites that cache-out at idle fire here.
  const profile = await captureAllocProfile(page, `
    const phase = t < 0.5 ? t * 2 : (1 - t) * 2;
    cam.zoom = 10 + phase * 4;
    cam.centerX = ${baseCam.x} + phase * 200000;
  `, 3000)
  const sorted = Object.entries(profile).sort((a, b) => b[1] - a[1])
  if (sorted.length > 0) {
    // eslint-disable-next-line no-console
    console.log('\n=== Alloc profile — zoom+pan 3s ===')
    for (const [key, count] of sorted.slice(0, 20)) {
      // eslint-disable-next-line no-console
      console.log(`  ${count.toString().padStart(7)}  ${key}`)
    }
  } else {
    // eslint-disable-next-line no-console
    console.log('\n[alloc-profile] empty (sites cached-out or API missing)')
  }
})
