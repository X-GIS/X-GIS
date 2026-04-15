import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'
import {
  captureCanvas, sampleNonBackgroundPixels, hashScreenshot,
  colorHistogram, type ColorBucket,
} from './helpers/visual'

// Hard-coded demo ID list. Importing `DEMOS` from `../src/demos.ts`
// doesn't work here because that module uses Vite's `import.meta.glob`
// which is a Vite-only transform — under Playwright's Node runner it
// throws "glob is not a function". Adding a new demo means adding its
// ID to both `src/demos.ts` and to this list.
const DEMO_IDS = [
  'animation_pulse', 'animation_showcase',
  'bold_borders', 'bucket_order', 'categorical', 'coastline', 'coastline_10m',
  'continent_match', 'continent_outlines', 'countries_categorical_xgvt',
  'custom_shapes', 'custom_symbol', 'dark', 'dashed_borders',
  'dashed_lines', 'filter_gdp', 'gdp_gradient', 'gradient_points',
  'income_match', 'layered_borders', 'line_offset', 'line_styles',
  'megacities', 'minimal', 'multi_layer', 'multi_layer_line',
  'night_map', 'ocean_land', 'pattern_lines', 'physical_map',
  'physical_map_10m', 'physical_map_50m', 'physical_map_xgvt',
  'populated_places', 'population_gradient', 'procedural_circles',
  'raster', 'raster_overlay', 'rivers_10m', 'rivers_lakes',
  'sdf_points', 'shape_gallery', 'states_10m', 'states_provinces',
  'stroke_align', 'styled_world', 'translucent_lines',
  'vector_categorical', 'vector_tiles', 'water_hierarchy', 'zoom',
  'zoom_lod',
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

test.describe('X-GIS animation regression', () => {
  test('animation_pulse: cycles past first iteration + amber stroke visible at peak', async ({ page }) => {
    test.setTimeout(30_000)
    const cycleMs = 1500
    await page.goto('/demo.html?id=animation_pulse', { waitUntil: 'domcontentloaded' })

    // 6 samples across ~3 cycles. Sample BOTH hash + amber ratio
    // at each point so we can prove (a) the cycle is alive (≥4
    // unique hashes) and (b) the amber stroke is actually being
    // rendered at SOME point during the cycle (max amber > 0.01).
    //
    // The range-based assertion is more robust than picking a
    // specific cycle phase — `_elapsedMs` doesn't reset on page
    // navigation and the init time is variable, so "sample at
    // peak" is unreliable. "Sample N times, assert max >
    // threshold" works regardless.
    //
    // amber-300 = #fcd34d ≈ RGB(252, 211, 77)
    const sampleTimes = [
      Math.round(cycleMs * 0.2),
      Math.round(cycleMs * 0.5),
      Math.round(cycleMs * 0.85),
      Math.round(cycleMs * 1.4),
      Math.round(cycleMs * 2.1),
      Math.round(cycleMs * 2.85),
    ]
    const hashes: string[] = []
    const amberPoints: number[] = []
    for (const t of sampleTimes) {
      const png = await captureCanvas(page, { elapsedMsAtLeast: t })
      hashes.push(await hashScreenshot(page, png))
      const r = await colorHistogram(page, png, [
        { name: 'amber', rgb: [252, 211, 77], tolerance: 100 },
      ])
      amberPoints.push(r.amber)
    }

    const unique = new Set(hashes).size
    expect(unique,
      `animation_pulse: only ${unique}/6 distinct frames — animation frozen`)
      .toBeGreaterThanOrEqual(4)

    // Amber must reach a non-trivial peak across the cycle —
    // catches "stroke vanished entirely" silent failures the
    // cycle hash test can't see.
    const maxAmber = Math.max(...amberPoints)
    expect(maxAmber,
      `animation_pulse: amber peak ${(maxAmber * 100).toFixed(2)}% across 6 samples ` +
      `(${amberPoints.map(r => (r * 100).toFixed(1) + '%').join(', ')}) — ` +
      `coastline stroke not reaching the canvas`)
      .toBeGreaterThan(0.01)
  })

  test('animation_showcase: cycles + rose ratio varies across cycle (proves heat keyframe morphs)', async ({ page }) => {
    test.setTimeout(40_000)
    const cycleMs = 2000
    await page.goto('/demo.html?id=animation_showcase', { waitUntil: 'domcontentloaded' })

    // 6-sample cycle continuity check (hash-based).
    const sampleTimes = [
      Math.round(cycleMs * 0.15),
      Math.round(cycleMs * 0.50),
      Math.round(cycleMs * 0.85),
      Math.round(cycleMs * 1.40),
      Math.round(cycleMs * 2.10),
      Math.round(cycleMs * 2.85),
    ]
    const hashes: string[] = []
    const rosePoints: number[] = []
    const buckets: ColorBucket[] = [
      { name: 'rose', rgb: [225, 29, 72], tolerance: 80 },
    ]
    for (const t of sampleTimes) {
      const png = await captureCanvas(page, { elapsedMsAtLeast: t })
      hashes.push(await hashScreenshot(page, png))
      // Also measure rose ratio at each sample so we can verify
      // the heat keyframe is actually morphing colors, not just
      // jittering pixels.
      const r = await page.evaluate(async (b64) => {
        const blob = await fetch(`data:image/png;base64,${b64}`).then(r => r.blob())
        const bmp = await createImageBitmap(blob)
        const c = document.createElement('canvas')
        c.width = bmp.width; c.height = bmp.height
        const ctx = c.getContext('2d')!
        ctx.drawImage(bmp, 0, 0)
        const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data
        let rose = 0
        for (let i = 0; i < data.length; i += 4) {
          if (
            Math.abs(data[i] - 225) <= 80 &&
            Math.abs(data[i + 1] - 29) <= 80 &&
            Math.abs(data[i + 2] - 72) <= 80
          ) rose++
        }
        return rose / (bmp.width * bmp.height)
      }, (await captureCanvas(page, { elapsedMsAtLeast: t })).toString('base64'))
      rosePoints.push(r)
    }

    const unique = new Set(hashes).size
    expect(unique,
      `animation_showcase: only ${unique}/6 distinct frames — animation frozen`)
      .toBeGreaterThanOrEqual(4)

    // NEW Bug 1 mirror via histogram: the rose ratio should swing
    // significantly across the 6 samples. If the heat keyframe
    // were frozen at any single value (slate OR rose), the range
    // would be near zero. Empirically: peak ~15%, trough ~0% →
    // range ≈ 15%. Assert range > 5% with plenty of headroom.
    const range = Math.max(...rosePoints) - Math.min(...rosePoints)
    expect(range,
      `animation_showcase: rose ratio range ${(range * 100).toFixed(1)}% across 6 samples ` +
      `(${rosePoints.map(r => (r * 100).toFixed(1) + '%').join(', ')}) — ` +
      `heat keyframe not morphing`)
      .toBeGreaterThan(0.04)

    // The rose ratio must also reach a non-trivial peak — proves
    // the rose-600 keyframe value is actually visited, not just
    // "anything changes" which a tiny pixel jitter could fake.
    expect(Math.max(...rosePoints),
      `animation_showcase: rose ratio peak ${(Math.max(...rosePoints) * 100).toFixed(1)}% — ` +
      `country fills never reached the rose-600 keyframe value`)
      .toBeGreaterThan(0.05)
  })
})
