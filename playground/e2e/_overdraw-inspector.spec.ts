// Smoke + capture spec for the `?debug=overdraw` fragment-count
// heatmap inspector. Drives several real demos with the debug flag
// on, screenshots each pane, and writes them as artifacts. Soft
// gate — the spec verifies (a) no GPU validation errors fire, (b)
// the heatmap canvas isn't uniformly black (some pixels showed
// non-zero overdraw, i.e. the pipeline at least ran end-to-end).
//
// v1 coverage: background, vector-tile fills (incl. fallback,
// ground, extruded variants — all collapse to one debug pipeline).
// v1 gaps (documented for Phase 2): SDF strokes, text/halo, SDF
// points, raster tiles. Those renderers skip themselves in debug
// mode rather than crash the pass with a format mismatch.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__overdraw-inspector__')
mkdirSync(OUT, { recursive: true })

interface Preset {
  id: string         // demo id
  name: string       // file slug
  hash: string       // #z/lat/lon[/bearing/pitch]
}

const PRESETS: Preset[] = [
  // World view — minimal layer stacking, mostly BG + water + earth.
  // Expect cool colors throughout (1-3× overdraw).
  { id: 'osm_style', name: 'world',     hash: '#2/20/0' },
  // Manhattan z=14 with pitch — dense landuse / buildings, fills
  // stack 4-5×. Roads and Central Park contrast clearly.
  { id: 'osm_style', name: 'manhattan', hash: '#14/40.78/-73.97/0/45' },
  // Tokyo z=14 — another dense urban target, no pitch for a flatter
  // comparison.
  { id: 'osm_style', name: 'tokyo',     hash: '#14/35.68/139.76' },
]

for (const preset of PRESETS) {
  test(`overdraw inspector: ${preset.name}`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 800, height: 600 })

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      const t = m.text()
      if (t.includes('vite/dist/client')) return
      if (t.includes('Failed to load resource')) return
      errors.push(t)
    })

    await page.goto(`/demo.html?id=${preset.id}&debug=overdraw${preset.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 },
    )
    await page.waitForTimeout(4_000)

    const png = await page.locator('#map').screenshot()
    writeFileSync(join(OUT, `${preset.name}.png`), png)

    // Validation errors are catastrophic — any pipeline format
    // mismatch shows up as a [X-GIS frame-validation] console.error
    // and the swapchain may stay black. Fail loudly so debug-mode
    // regressions don't get masked by the soft pixel-count check.
    expect(errors,
      `GPU validation / console errors during debug=overdraw render:\n${errors.join('\n')}`,
    ).toEqual([])

    // Soft check: the canvas must paint *something* — the colormap
    // outputs (0.02, 0.02, 0.04) for zero fragments (a dark navy), so
    // even a totally empty scene wouldn't be pure black. Detect a
    // catastrophic blank by sampling a few pixels.
    const stats = await page.evaluate(async () => {
      const canvas = document.getElementById('map') as HTMLCanvasElement
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob((b) => res(b), 'image/png'))
      if (!blob) return { ok: false, reason: 'canvas.toBlob null' }
      const bitmap = await createImageBitmap(blob)
      const off = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = off.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
      let nonBlack = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 15 || data[i + 1] > 15 || data[i + 2] > 15) nonBlack++
      }
      return { ok: nonBlack > 0, nonBlackPixels: nonBlack }
    })
    expect(stats.ok,
      `heatmap canvas appears blank (no pixels above colormap floor)`,
    ).toBe(true)
  })
}
