// Visual render verification — captures a screenshot of each major demo
// and asserts the canvas has painted non-background pixels. Catches
// silent regressions where the runtime runs clean but renders nothing.

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__render-verify__')
mkdirSync(ART, { recursive: true })

const DEMOS = [
  'minimal',
  'raster',
  'multi_layer',
  'categorical',
  'continent_match',
  'sdf_points',
  'line_styles',
  'pattern_lines',
  'translucent_lines',
  'physical_map',
  'animation_pulse',
]

for (const id of DEMOS) {
  test(`render: ${id}`, async ({ page }) => {
    test.setTimeout(30_000)
    await page.setViewportSize({ width: 1200, height: 700 })

    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

    await page.goto(`/demo.html?id=${id}&e2e=1`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 15_000 },
    )
    await page.waitForTimeout(600)

    // Capture + analyze pixels of the map canvas only.
    const png = await page.locator('#map').screenshot()
    writeFileSync(join(ART, `${id}.png`), png)

    const stats = await page.evaluate(async (b64) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then(r => r.blob())
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width; c.height = bmp.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      let nonBg = 0
      // Track the unique color histogram so a single-color fill shows up
      // distinctly from a real map.
      const seen = new Set<number>()
      for (let i = 0; i < d.length; i += 4) {
        if (Math.max(d[i], d[i + 1], d[i + 2]) > 12) nonBg++
        if (i % 40 === 0) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2])
      }
      return { nonBg, unique: seen.size, total: (d.length / 4) | 0 }
    }, png.toString('base64'))

    const real = errors.filter(e => !/404|Failed to load|powerPreference/.test(e))
    expect.soft(real, `errors: ${real.join(' | ')}`).toHaveLength(0)
    // At least 1% of pixels should be painted above near-black threshold.
    expect.soft(stats.nonBg, `non-bg pixels out of ${stats.total}`).toBeGreaterThan(stats.total * 0.01)
    // At least 3 distinct colors — a single fill + bg counts as 2, so
    // anything below means the map rendered as a solid block (stroke,
    // feature data, or antialiasing all missing).
    expect.soft(stats.unique, `unique colors sampled`).toBeGreaterThanOrEqual(3)

    console.log(`[${id}] nonBg=${stats.nonBg}/${stats.total} unique=${stats.unique} errors=${real.length}`)
  })
}
