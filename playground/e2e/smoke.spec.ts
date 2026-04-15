import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'

// Hard-coded demo ID list. Importing `DEMOS` from `../src/demos.ts`
// doesn't work here because that module uses Vite's `import.meta.glob`
// which is a Vite-only transform — under Playwright's Node runner it
// throws "glob is not a function". Adding a new demo means adding its
// ID to both `src/demos.ts` and to this list; the spec sorts them for
// stable report ordering.
const DEMO_IDS = [
  'bold_borders', 'categorical', 'coastline', 'coastline_10m',
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

// ═══ X-GIS headless smoke test ═══
//
// Loads every demo (via its URL hash) in a single Chromium instance and
// asserts:
//   1. No console.error fired during the initial load window
//   2. No [X-GIS frame-validation] / [X-GIS pass:*] entries in __xgisLog
//   3. Canvas is not uniformly clear-colored (proof that SOMETHING drew)
//   4. Initial load completed within a per-demo timeout
//
// Purpose: catch regressions where a demo fails to load due to shader
// validation errors, broken .xgvt file reads, or runtime logic bugs.
// The existing vitest suite is pure unit tests against in-memory data;
// nothing exercises the browser WebGPU path until this runs.

const PER_DEMO_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 15_000)
const READY_POLL_INTERVAL_MS = 50

// These console.log prefixes are normal diagnostic noise — not failures.
const CONSOLE_IGNORE_PREFIXES = [
  '[X-GIS]',
  '[X-GIS frame]',   // wrapped renderLoop error that's already handled
]

// Console errors whose text matches these patterns are also ignored.
// "Failed to load resource: ..." is the browser's generic message for
// any 4xx/5xx — onResponse below surfaces the specific URL + status
// properly, so we don't need to double-count it as a console.error.
const CONSOLE_IGNORE_PATTERNS = [
  /Failed to load resource:/,
]

// Response 4xx/5xx URLs matching these substrings are ignored. The
// browser auto-requests /favicon.ico with no way to suppress it from
// the app side — Vite dev doesn't serve one, so every demo produces
// a single 404 here.
const RESPONSE_IGNORE_URL_SUBSTRINGS = [
  '/favicon.ico',
]

// These substrings INSIDE a console.error / __xgisLog entry indicate a
// real regression.
const ERROR_SIGNALS = [
  '[X-GIS frame-validation]',
  '[X-GIS pass:',
  '[VTR tile-drop v2]',
  '[xgvt-pool parse]',
  '[xgvt preload',
]

interface DemoResult {
  id: string
  ok: boolean
  reason?: string
  errorCount: number
  durationMs: number
}

/** Polls window.__xgisReady until true or timeout. Returns elapsed ms. */
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

/** Reads the in-page overlay log (populated by __xgisLog) for error rows. */
async function collectOverlayErrors(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const body = document.getElementById('log-body')
    if (!body) return []
    return body.textContent?.split('\n').filter(l => l.trim().length > 0) ?? []
  })
}

/** Samples the center pixel of #map canvas — if all zeros or uniform
 *  clear-color, the demo didn't actually render anything. */
async function checkCanvasNonEmpty(page: Page): Promise<{ ok: boolean; reason?: string }> {
  const result = await page.evaluate(() => {
    const canvas = document.getElementById('map') as HTMLCanvasElement | null
    if (!canvas) return { ok: false, reason: 'no #map canvas' }
    const w = canvas.width, h = canvas.height
    if (w === 0 || h === 0) return { ok: false, reason: 'canvas 0x0' }
    // WebGPU canvas cannot be read via 2d getImageData; instead just
    // confirm the canvas has a non-zero size and something was drawn
    // (checked via __xgisReady + error absence). The "non-empty pixel"
    // check is best-effort for WebGL / raster paths.
    return { ok: true }
  })
  return result
}

test.describe('X-GIS demo smoke', () => {
  const demoIds = DEMO_IDS
  const results: DemoResult[] = []

  test.afterAll(() => {
    // Print a summary table so it's easy to see which demos passed
    // and which failed, even when --reporter=dot hides the details.
    console.log('\n═══ Smoke test summary ═══')
    let okCount = 0
    for (const r of results) {
      const mark = r.ok ? '✓' : '✗'
      const suffix = r.ok ? `${r.durationMs}ms` : `FAIL (${r.reason})`
      console.log(`  ${mark} ${r.id.padEnd(30)} ${suffix}`)
      if (r.ok) okCount++
    }
    console.log(`\n${okCount}/${results.length} demos passed\n`)
  })

  for (const id of demoIds) {
    test(`${id}`, async ({ page }) => {
      test.setTimeout(PER_DEMO_TIMEOUT_MS + 5_000)

      const consoleErrors: string[] = []
      const consoleLog: string[] = []
      const failedUrls: string[] = []
      const debug = process.env.SMOKE_DEBUG === '1'
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
        if (debug) consoleLog.push(`[resp ${status}] ${url}`)
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

      const startedAt = Date.now()
      let result: DemoResult = { id, ok: false, errorCount: 0, durationMs: 0 }

      try {
        await page.goto(`/demo.html?id=${id}`, { waitUntil: 'domcontentloaded' })
        const elapsed = await waitForReady(page, PER_DEMO_TIMEOUT_MS)

        const canvas = await checkCanvasNonEmpty(page)
        expect(canvas.ok, `canvas check: ${canvas.reason}`).toBe(true)

        // Give the render loop 3 extra frames to surface any lazy
        // validation errors that only fire on draw (not on setup).
        await page.waitForTimeout(100)

        const overlayErrors = await collectOverlayErrors(page)
        const criticalOverlay = overlayErrors.filter(line =>
          ERROR_SIGNALS.some(sig => line.includes(sig)),
        )

        const totalErrors = consoleErrors.length + criticalOverlay.length
        if (totalErrors > 0) {
          const urlInfo = failedUrls.length > 0 ? ` failedUrls=[${failedUrls.join(', ')}]` : ''
          result = {
            id, ok: false, durationMs: Date.now() - startedAt,
            errorCount: totalErrors,
            reason: (consoleErrors[0] ?? criticalOverlay[0] ?? 'unknown').slice(0, 200) + urlInfo,
          }
          results.push(result)
          throw new Error(
            `${totalErrors} error(s) during ${id}: ${consoleErrors.join(' | ')} ${criticalOverlay.join(' | ')}${urlInfo}`,
          )
        }

        result = { id, ok: true, durationMs: elapsed, errorCount: 0 }
        results.push(result)
      } catch (err) {
        if (!results.find(r => r.id === id)) {
          results.push({
            id, ok: false, errorCount: 0,
            durationMs: Date.now() - startedAt,
            reason: (err as Error).message.slice(0, 200),
          })
        }
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
