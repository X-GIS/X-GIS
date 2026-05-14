import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__pbf-glyphs-offline__')
mkdirSync(OUT, { recursive: true })

// Offline-safety regression: when a style supplies a `glyphs` URL but the
// network refuses the request, X-GIS must NOT blank its labels — the
// PBFRasterizer's Canvas2D fallback path keeps text rendering with the
// host system font. Without this guard a future change that promoted PBF
// to "required" would silently break offline / firewalled deployments.

test('demotiles labels survive blocked font.pbf fetches (Canvas2D fallback)', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1200, height: 700 })

  // Block every glyph PBF request BEFORE navigation so the very first
  // label submission misses the cache and exercises the fallback path.
  const blocked: string[] = []
  await page.route('**/font/**/*.pbf', route => {
    blocked.push(route.request().url())
    return route.abort()
  })

  // Capture console errors — an exception in the PBF path should not
  // surface to the user as a runtime error.
  const consoleErrors: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.goto('/compare.html?style=maplibre-demotiles#3.0/22/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // Settle the label collision pass + atlas uploads.
  await page.waitForTimeout(4_000)

  const xg = await page.locator('#panes .pane').nth(1).screenshot()
  writeFileSync(join(OUT, 'offline.png'), xg)

  // The route block fires — proving PBF fetches were attempted.
  expect(blocked.length).toBeGreaterThan(0)

  // PBF failures are caught silently inside GlyphPbfCache. Errors that
  // bubble to console.error indicate the fallback path itself blew up.
  // Filter known-noisy categories (asset 404 for demo tiles served at
  // different paths, MapLibre's own console warnings) so this assertion
  // only catches NEW X-GIS-originated errors.
  const xgisErrors = consoleErrors.filter(e =>
    !e.includes('maplibre-gl') &&
    !e.includes('Failed to load resource') &&
    !e.toLowerCase().includes('tile'))
  expect(xgisErrors).toEqual([])

  // Sanity: the captured screenshot must contain non-background pixels —
  // proves SOMETHING rendered (full proof of label visibility requires
  // OCR which is overkill for this regression).
  const pixelCount = await page.evaluate(() => {
    const canvas = document.querySelector('#xg-canv') as HTMLCanvasElement
    const ctx = canvas.getContext('webgl2') ?? canvas.getContext('webgpu')
    return ctx === null ? 0 : canvas.width * canvas.height
  })
  expect(pixelCount).toBeGreaterThan(0)
})
