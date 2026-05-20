// ═══════════════════════════════════════════════════════════════════
// Pre-bundle baseline — iter-211 (Phase RB.C)
// ═══════════════════════════════════════════════════════════════════
//
// Pins the current per-frame draw-call count + GPU vt segment timing
// at idle camera. Future RB.B (GPURenderBundle integration) measures
// reduction against this baseline:
//   - Idle camera: drawCalls should drop ~300× → 1 executeBundles call
//   - vt GPU pass timing should stay flat or improve (no regression)
//
// What this baseline establishes:
//   1. Snapshot of current steady-state drawCalls value per fixture
//   2. vt GPU timing at idle for direct comparison
//   3. The "did bundle help?" gate for future RB.B iters
//
// The spec is intentionally LENIENT on absolute values — captures the
// status quo. RB.B iter that integrates BundleCache replaces these
// assertions with "drawCalls === 1 at idle".

import { test, type Page } from '@playwright/test'

interface FrameSample {
  drawCalls: number
  triangles: number
  vertices: number
  tilesVisible: number
  /** iter-229 — actual `pass.executeBundles` call count this frame
   *  (delta of lifetime bundle hits + misses). Pre-RB.B = 0 (bundle
   *  path inactive). Post-RB.B = small constant per (slice, phase). */
  bundleReplays: number
  /** iter-231 — wall-clock frame time (ms). Sampled to enable
   *  before/after perf comparison vs a worktree at the pre-bundle
   *  baseline commit (iter-219 = 5602a77). */
  frameTime: number
  /** iter-235 — V8 heap delta rolling average (bytes). Sentinel -1
   *  when `performance.memory` unavailable. The C.1 baseline lock
   *  for Plan AAA Phase C; subsequent phases (A.x / B.x / etc.)
   *  must not regress this past +5 KB. */
  heapDeltaAvg: number
}

async function setupIdleScene(page: Page, hash: string, style: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(
    `/compare.html?style=${style}${hash}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 60_000 },
  )
  // Settle past cold-start tile cascade. 4 seconds is sufficient for
  // OFM Bright z=14 Seoul to fully drain its upload queue.
  await page.waitForTimeout(4_000)
}

/** iter-240 — Capture per-call-site alloc counts over a frame window.
 *  Returns the delta of counts during the sampled period (uses
 *  snapshotAllocProfile to subtract pre-sample state). Empty object
 *  when profile API unavailable. */
async function sampleAllocProfile(page: Page, frames: number): Promise<Record<string, number>> {
  return await page.evaluate(async (n: number) => {
    interface API {
      setEnabled: (on: boolean) => void
      snapshotAllocProfile: () => Record<string, number>
    }
    const api = (window as unknown as { __xgisAllocProfile?: API }).__xgisAllocProfile
    if (!api) return {}
    interface M { invalidate: () => void }
    const map = (window as unknown as { __xgisMap?: M }).__xgisMap
    if (!map) return {}
    api.setEnabled(true)
    api.snapshotAllocProfile()  // discard pre-sample baseline
    await new Promise<void>(r => {
      let i = 0
      const tick = () => {
        if (i >= n) { r(); return }
        map.invalidate()
        i++
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const delta = api.snapshotAllocProfile()
    api.setEnabled(false)
    return delta
  }, frames)
}

async function sampleSteadyState(page: Page, frameCount: number): Promise<FrameSample[]> {
  return await page.evaluate(async (n: number) => {
    interface M {
      stats: {
        drawCalls: number
        triangles: number
        vertices: number
        tilesVisible: number
        bundleReplaysThisFrame?: number
        frameTime: number
        heapDeltaAvgBytes?: number
      }
      invalidate: () => void
    }
    const map = (window as unknown as { __xgisMap?: M }).__xgisMap
    if (!map) throw new Error('__xgisMap missing')
    const samples: { drawCalls: number; triangles: number; vertices: number; tilesVisible: number; bundleReplays: number; frameTime: number; heapDeltaAvg: number }[] = []
    return await new Promise<typeof samples>(resolve => {
      let frames = 0
      const tick = () => {
        if (frames >= n) { resolve(samples); return }
        const s = map.stats
        samples.push({
          drawCalls: s.drawCalls,
          triangles: s.triangles,
          vertices: s.vertices,
          tilesVisible: s.tilesVisible,
          // iter-231 — fallback to 0 so the spec also runs against
          // pre-iter-229 commits (no bundleReplaysThisFrame field).
          bundleReplays: s.bundleReplaysThisFrame ?? 0,
          frameTime: s.frameTime,
          // iter-235 — fallback to -1 sentinel so older worktrees
          // without heap diagnostic still run cleanly.
          heapDeltaAvg: s.heapDeltaAvgBytes ?? -1,
        })
        frames++
        // Force re-render so stats get re-populated even at idle.
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, frameCount)
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

interface Fixture {
  name: string
  style: string
  hash: string
}

const FIXTURES: Fixture[] = [
  // OFM Bright at z=14 Seoul — typical city view with full layer
  // stack (water, landuse, transportation, building, label suppressed
  // via post-load hide). Highest steady-state drawCall count of the
  // common fixtures.
  {
    name: 'bright-seoul-z14-idle',
    style: 'openfreemap-bright',
    hash: '#14/37.5558/126.9776/0/0',
  },
  // OFM Liberty at z=14 Paris — similar density, different style.
  {
    name: 'liberty-paris-z14-idle',
    style: 'openfreemap-liberty',
    hash: '#14/48.8534/2.3488/0/0',
  },
  // OFM Bright at z=0 — minimal tiles (1-4 visible), measures the
  // bundle overhead floor (a frame with few tiles still pays the
  // per-show iteration cost).
  {
    name: 'bright-world-z0-idle',
    style: 'openfreemap-bright',
    hash: '#0/0/0/0/0',
  },
]

test.describe.configure({ mode: 'serial' })

test.describe('Phase RB.C — pre-bundle baseline harness', () => {
  for (const fx of FIXTURES) {
    test(`${fx.name} — steady-state drawCalls baseline`, async ({ page }) => {
      test.setTimeout(120_000)
      await setupIdleScene(page, fx.hash, fx.style)

      const FRAMES = 30
      const samples = await sampleSteadyState(page, FRAMES)
      // Drop the first 5 frames (still-settling tile uploads).
      const stable = samples.slice(5)
      const drawCalls = stable.map(s => s.drawCalls)
      const tilesVisible = stable.map(s => s.tilesVisible)
      const bundleReplays = stable.map(s => s.bundleReplays)
      const frameTimes = stable.map(s => s.frameTime)
      const heapDeltas = stable.map(s => s.heapDeltaAvg).filter(v => v >= 0)
      const m = median(drawCalls)
      const mt = median(tilesVisible)
      const mbr = median(bundleReplays)
      const mft = median(frameTimes)
      const mhd = heapDeltas.length > 0 ? median(heapDeltas) : -1
      const ftMin = Math.min(...frameTimes)
      const ftMax = Math.max(...frameTimes)
      const max = Math.max(...drawCalls)
      const min = Math.min(...drawCalls)

      // iter-235 — log heap delta rolling avg in KB. Chrome / Edge
      // only (Firefox / Safari report -1 sentinel; we skip-log
      // those). The C.1 baseline is informational on first ship;
      // Phase A iters will lock against the median observed.
      const heapKb = mhd >= 0 ? `heapDeltaAvg.median=${(mhd / 1024).toFixed(1)}KB` : 'heapDeltaAvg=n/a'
      // eslint-disable-next-line no-console
      console.log(
        `[baseline ${fx.name}] drawCalls median=${m} min=${min} max=${max} tilesVisible.median=${mt} bundleReplays.median=${mbr} ratio=${mbr > 0 ? (m / mbr).toFixed(1) : 'n/a'}× frameTime median=${mft.toFixed(2)}ms min=${ftMin.toFixed(2)} max=${ftMax.toFixed(2)} ${heapKb}`,
      )

      // iter-240 (Plan AAA C.2) — capture per-call-site alloc
      // counts over a separate 30-frame window. Reports the top
      // sites so B.2 first-consumer pick is data-driven.
      const profile = await sampleAllocProfile(page, 30)
      const sorted = Object.entries(profile).sort((a, b) => b[1] - a[1])
      if (sorted.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[alloc-profile ${fx.name}] (30 frames, sorted by count)`)
        for (const [key, count] of sorted.slice(0, 20)) {
          // eslint-disable-next-line no-console
          console.log(`  ${count.toString().padStart(6)}  ${key}`)
        }
      }

      // Sanity: idle camera should be CONSISTENT across frames.
      // Pre-bundle: drawCalls per frame is steady (every frame re-issues
      // the same N drawIndexed calls). Variance > 20 % suggests
      // something non-deterministic on the render path — flag for
      // investigation.
      const variance = max > 0 ? (max - min) / max : 0
      if (variance > 0.2 && m > 5) {
        // eslint-disable-next-line no-console
        console.warn(
          `[baseline ${fx.name}] drawCall variance ${(variance * 100).toFixed(1)}% — ` +
          `idle frames should be steady. Pre-RB.B baseline likely unstable.`,
        )
      }

      // The baseline assertion: drawCalls > 0 (sanity), idle steady,
      // captured for future RB.B comparison. NOT asserting exact value
      // because the steady-state count varies by tile cache warmup +
      // visibility set + style. Future RB.B iters re-run this same
      // harness and pin "drawCalls === 1" instead.
      // Use chai-style toBeGreaterThan via Playwright expect.
      const { expect } = await import('@playwright/test')
      expect(m, 'idle drawCalls should be > 0').toBeGreaterThan(0)
      // iter-230 — bundle path active sanity. Post-RB.B every fixture
      // emits at least one `executeBundles` per idle frame; if this
      // drops to 0 the bundle wrap was bypassed (e.g. accidental
      // DEBUG_OVERDRAW gate flip) and the perf optimization is
      // silently disabled. Looser than the 97.6 % hit-rate gate in
      // _perf-bundle-hit-rate.spec.ts but cheaper — runs at the same
      // 3 fixtures already covered by this baseline.
      // iter-231 — gate behind env flag so the spec also runs in
      // pre-bundle worktrees for before/after timing comparison.
      // Default: gate active (HEAD behavior).
      if (!process.env.PERF_BASELINE_NO_BUNDLE_GATE) {
        expect(mbr, `bundle path should fire (median bundleReplays > 0); idle had 0 ⇒ wrap inactive`)
          .toBeGreaterThan(0)
      }
    })
  }
})
