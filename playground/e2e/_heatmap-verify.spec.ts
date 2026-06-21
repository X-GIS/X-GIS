import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

test('heatmap renders a density blob', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 700 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=heatmap&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true, null, { timeout: 15_000 })
  await page.waitForTimeout(2500)

  const state = await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: Record<string, unknown> }).__xgisMap
    if (!m) return { noMap: true }
    const hr = m.heatmapRenderer as { layers?: unknown[] } | null
    const hpd = m.heatmapPointData as Map<string, { features?: unknown[] }> | undefined
    return {
      heatmapLayers: hr?.layers?.length ?? 'n/a',
      heatmapPointDataKeys: hpd ? [...hpd.keys()] : 'no map',
      citiesPts: hpd?.get('cities')?.features?.length ?? 'none',
    }
  })
  console.log('VERIFY_STATE:', JSON.stringify(state), 'errors=', errors.length)

  const png = await page.locator('#map').screenshot()
  writeFileSync(join(HERE, '__render-verify__', 'heatmap-verify.png'), png)

  // Gate: the heatmap's geojson points must survive tiling (heatmapPointData)
  // AND reach the HeatmapRenderer (>=1 layer). This is the exact regression
  // the tile-aware fix closed — both were 0 / absent before. CPU-side state
  // (no GPU dependency), so it holds under CI SwiftShader too.
  expect.soft(state.heatmapLayers, 'HeatmapRenderer must have >=1 layer').toBe(1)
  expect.soft(state.citiesPts, 'cities point features preserved').toBe(243)
  expect.soft(errors, `page errors: ${errors.join(' | ')}`).toHaveLength(0)
})
