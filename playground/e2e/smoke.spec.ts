import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'
import { captureCanvas, sampleNonBackgroundPixels } from './helpers/visual'

// Production smoke runs against a SMALL curated set of demos —
// not all 50. Per-feature regression coverage lives in the
// fixtures.spec.ts / interactions.spec.ts / reftest.spec.ts
// suites; this file only exists to catch tile-loader / data
// pipeline / demo-runner regressions that pure fixtures can't
// isolate.
//
// The 5 demos here were selected for their integration coverage:
//   - physical_map_10m: large xgvt tile load path
//   - vector_categorical: shader variant + storage buffer
//   - bucket_order: bucket scheduler PR2 regression target
//   - sdf_points: direct-layer points (Bug 2 mirror)
//   - water_hierarchy: translucent + multi-source stacking
//
// To re-add a demo as a smoke target, add its ID here AND bake a
// new baseline via `bun run test:e2e -- --update-snapshots`.
const DEMO_IDS = [
  'physical_map_10m',
  'vector_categorical',
  'bucket_order',
  'sdf_points',
  'water_hierarchy',
]

// ═══ X-GIS consolidated e2e suite ═══
//
// One per-demo test that performs every relevant assertion in a
// single page session:
//
//   1. Navigate + wait __xgisReady
//   2. Smoke check (console errors, response 4xx/5xx, overlay errors)
//   3. Baseline screenshot match (skipped for animated demos)
//   4. Bug 2 mirror — non-background pixel sample (point demos only)
//
// Animation demos get their own describe block below — they need
// multiple page loads at distinct `_elapsedMs` values for the cycle
// continuity test, can't be merged into a single-load test.
//
// Per-demo categorization:
//   - ANIMATED_DEMOS: skip baseline (content depends on _elapsedMs)
//   - TILE_HEAVY_DEMOS: 2s settle + 5% diff cap (tile composition jitter)
//   - POINT_DEMOS: also run Bug 2 non-background sample assertion

const PER_DEMO_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 15_000)
const READY_POLL_INTERVAL_MS = 50

// Console error filters
const CONSOLE_IGNORE_PREFIXES = [
  '[X-GIS]',
  '[X-GIS frame]',
]
const CONSOLE_IGNORE_PATTERNS = [
  /Failed to load resource:/,
]
const RESPONSE_IGNORE_URL_SUBSTRINGS = [
  '/favicon.ico',
]
const ERROR_SIGNALS = [
  '[X-GIS frame-validation]',
  '[X-GIS pass:',
  '[VTR tile-drop v2]',
  '[xgvt-pool parse]',
  '[xgvt preload',
]

// Demos whose visible content depends on `_elapsedMs` and would
// never be pixel-stable between runs. Their per-cycle correctness
// is verified by the dedicated animation describe below.
const ANIMATED_DEMOS = new Set(['animation_pulse', 'animation_showcase'])

// Demos that load large vector tile sets and need extra settle time
// before the canvas content is stable enough to baseline.
// `procedural_circles` is not tile-based but its CPU-procedural geometry
// has slight per-frame variance under parallel-worker GPU contention,
// so it gets the same loose tolerance.
const TILE_HEAVY_DEMOS = new Set([
  'physical_map_10m', 'physical_map_50m', 'physical_map_xgvt',
  'night_map', 'water_hierarchy', 'rivers_10m', 'states_10m',
  'countries_categorical_xgvt', 'states_provinces',
  'vector_tiles', 'vector_categorical', 'procedural_circles',
])

// Demos with SDF points — Bug 2 regression check (assert non-background
// pixels exist, proving the points actually reached the framebuffer).
const POINT_DEMOS = new Set([
  'sdf_points', 'gradient_points', 'megacities', 'custom_shapes',
  'shape_gallery', 'populated_places', 'procedural_circles',
  'custom_symbol',
])

// ── Helper utilities ──────────────────────────────────────────────

interface DemoResult {
  id: string
  ok: boolean
  reason?: string
  errorCount: number
  durationMs: number
}

async function waitForReady(page: Page, timeoutMs: number): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ready = await page.evaluate(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    )
    if (ready) return Date.now() - start
    await page.waitForTimeout(READY_POLL_INTERVAL_MS)
  }
  throw new Error(`__xgisReady did not become true within ${timeoutMs} ms`)
}

async function collectOverlayErrors(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const body = document.getElementById('log-body')
    if (!body) return []
    return body.textContent?.split('\n').filter(l => l.trim().length > 0) ?? []
  })
}

// ── Per-demo consolidated test ────────────────────────────────────

test.describe('X-GIS demo', () => {
  for (const id of DEMO_IDS) {
    test(`${id}`, async ({ page }) => {
      test.setTimeout(PER_DEMO_TIMEOUT_MS + 15_000)

      const consoleErrors: string[] = []
      const failedUrls: string[] = []
      const debug = process.env.SMOKE_DEBUG === '1'
      const consoleLog: string[] = []

      const onConsole = (msg: ConsoleMessage) => {
        const text = msg.text()
        const type = msg.type()
        if (debug) consoleLog.push(`[${type}] ${text}`)
        if (type !== 'error') return
        if (CONSOLE_IGNORE_PREFIXES.some(p => text.startsWith(p))) return
        if (CONSOLE_IGNORE_PATTERNS.some(p => p.test(text))) return
        consoleErrors.push(text)
      }
      const onResponse = (response: import('@playwright/test').Response) => {
        const status = response.status()
        const url = response.url()
        if (status >= 400) {
          if (RESPONSE_IGNORE_URL_SUBSTRINGS.some(s => url.includes(s))) return
          failedUrls.push(`${status} ${url}`)
        }
      }
      const onRequestFailed = (req: import('@playwright/test').Request) => {
        failedUrls.push(`FAIL ${req.url()} (${req.failure()?.errorText ?? 'unknown'})`)
      }
      page.on('console', onConsole)
      page.on('response', onResponse)
      page.on('requestfailed', onRequestFailed)
      page.on('pageerror', err => consoleErrors.push(`pageerror: ${err.message}`))

      try {
        // ── Phase 1: navigate + wait ready ──
        await page.goto(`/demo.html?id=${id}`, { waitUntil: 'domcontentloaded' })
        await waitForReady(page, PER_DEMO_TIMEOUT_MS)

        // Tile-heavy demos need extra settling for late tile loads.
        if (TILE_HEAVY_DEMOS.has(id)) {
          await page.waitForTimeout(2000)
        }

        // Capture once and reuse across all assertion phases.
        const png = await captureCanvas(page)

        // ── Phase 2: smoke check ──
        // Give the render loop 3 extra frames to surface lazy
        // validation errors that only fire on draw (not on setup).
        await page.waitForTimeout(100)

        const overlayErrors = await collectOverlayErrors(page)
        const criticalOverlay = overlayErrors.filter(line =>
          ERROR_SIGNALS.some(sig => line.includes(sig)),
        )

        const totalErrors = consoleErrors.length + criticalOverlay.length
        if (totalErrors > 0) {
          const urlInfo = failedUrls.length > 0 ? ` failedUrls=[${failedUrls.join(', ')}]` : ''
          throw new Error(
            `[smoke phase] ${totalErrors} error(s) during ${id}: ${consoleErrors.join(' | ')} ${criticalOverlay.join(' | ')}${urlInfo}`,
          )
        }

        // ── Phase 3: baseline screenshot match (skip animated) ──
        if (!ANIMATED_DEMOS.has(id)) {
          if (TILE_HEAVY_DEMOS.has(id)) {
            expect(png, `[baseline phase] ${id}`)
              .toMatchSnapshot(`${id}.png`, { maxDiffPixelRatio: 0.05 })
          } else {
            expect(png, `[baseline phase] ${id}`)
              .toMatchSnapshot(`${id}.png`)
          }
        }

        // ── Phase 4: Bug 2 mirror — non-background pixels for points ──
        if (POINT_DEMOS.has(id)) {
          const differing = await sampleNonBackgroundPixels(
            page, png,
            { r: 6, g: 8, b: 12 },
            50,
            400,
          )
          expect(differing,
            `[Bug 2 phase] ${id}: only ${differing}/400 sampled pixels differ from background — points likely missing`)
            .toBeGreaterThan(2)
        }
      } catch (err) {
        if (debug) {
          console.log(`\n─── ${id} console log (${consoleLog.length} msgs) ───`)
          for (const line of consoleLog) console.log('  ' + line)
          if (failedUrls.length > 0) {
            console.log('  failed URLs:')
            for (const u of failedUrls) console.log('    ' + u)
          }
          console.log('─── end ───\n')
        }
        throw err
      } finally {
        page.off('console', onConsole)
        page.off('response', onResponse)
        page.off('requestfailed', onRequestFailed)
      }
    })
  }
})

// ═══ Animation regression suite ═══════════════════════════════════
//
// Animation demos can't share a single page load because the cycle
// continuity test needs to sample the canvas at multiple distinct
// `_elapsedMs` values. Each test below loads the demo once and
// drives the page clock forward across multiple cycles, asserting:
//
//   1. Bug 1 cycle continuity (≥4 distinct hashes across 6 samples
//      spanning >3 cycles)
//   2. Color histogram at t=0 (starting keyframe state)
//   3. Color histogram at mid-cycle (proves animation is at the
//      expected color phase, not just "any non-base value")
//
// The histogram + pixel assertions are net-new coverage — they
// verify "the animation visits the right colors" instead of just
// "the canvas keeps changing".

// Animation regression suite extracted to playground/e2e/animation.spec.ts
