import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

test('inline-data geojson demo renders', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 700 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=inline_data&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true, null, { timeout: 15_000 })
  await page.waitForTimeout(2500)

  const state = await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: Record<string, unknown> }).__xgisMap
    if (!m) return { noMap: true }
    const raw = m.rawDatasets as Map<string, { features?: unknown[]; _vectorTile?: boolean }> | undefined
    const vt = m.vtSources as Map<string, unknown> | undefined
    const s = raw?.get('inline_pts')
    return {
      rawKeys: raw ? [...raw.keys()] : 'none',
      inlineFeatures: s?.features?.length ?? (s?._vectorTile ? 'tiled-marker' : 'MISSING'),
      vtKeys: vt ? [...vt.keys()] : 'none',
    }
  })
  console.log('INLINE_STATE:', JSON.stringify(state), 'errors=', errors.length, errors.slice(0, 2).join('|'))

  const png = await page.locator('#map').screenshot()
  writeFileSync(join(HERE, '__render-verify__', 'inline-data.png'), png)

  // Gate: a `data: {...}` inline source must reach the runtime AND be tiled
  // through the VirtualPMTiles geojson ingest (the url-equivalent path) — a
  // rawDatasets-only seed produced a blank frame. Real-GPU verified the box +
  // points render. CI render-gate runs this under SwiftShader.
  expect.soft(state.rawKeys, 'inline source registered').toContain('inline_pts')
  expect.soft(state.vtKeys, 'inline source tiled (VirtualPMTilesBackend)').toContain('inline_pts')
  expect.soft(state.inlineFeatures, 'inline source went through the tiling path').toBe('tiled-marker')
  expect.soft(errors, `page errors: ${errors.join(' | ')}`).toHaveLength(0)
})
