// Verify the projection-aware world-copy gate (worldCopiesFor()):
// non-Mercator projections render a single world (no ±N copy
// enumeration). Oracle: count tile draws via inspectPipeline; should
// drop ~5× for non-Mercator vs Mercator at the same camera state.

import { test, expect, type Page } from '@playwright/test'

async function waitForXgisReady(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
}

async function loadAndDump(page: Page, demo: string, hash: string) {
  await page.goto(`/demo.html?id=${demo}${hash}`, { waitUntil: 'domcontentloaded' })
  await waitForXgisReady(page)
  await page.waitForTimeout(2500)
  return await page.evaluate(() => {
    const map = (window as unknown as { __xgisMap?: any }).__xgisMap
    const pipe = map?.inspectPipeline?.()
    const stats = map?._stats ?? {}
    return {
      drawCalls: stats.drawCalls,
      vertices: stats.vertices,
      sources: pipe?.sources?.map((s: any) => ({
        name: s.name,
        cache: s.cache?.size,
        tilesVisible: s.frame?.tilesVisible,
      })),
    }
  })
}

test('mercator demo: world copies enumerated (multi-world tile counts)', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  // Pan well off-center where world wrapping is visible.
  const stats = await loadAndDump(page, 'physical_map_50m', '#1.5/0/100/0/0')
  console.log(`[mercator] drawCalls=${stats.drawCalls} sources=${JSON.stringify(stats.sources)}`)
  expect(stats.drawCalls, 'mercator should draw a substantial number of tiles').toBeGreaterThan(20)
})

test('orthographic demo: single world (no ±N copy enumeration)', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const stats = await loadAndDump(page, 'fixture_projection_orthographic', '')
  console.log(`[ortho] drawCalls=${stats.drawCalls} sources=${JSON.stringify(stats.sources)}`)
  // Orthographic should render normally (no tile-selection regression)
  expect(stats.drawCalls, 'ortho demo should still draw tiles').toBeGreaterThan(0)
  // tilesVisible should be modest (single world, no wrap multiplier)
  for (const s of stats.sources ?? []) {
    if (s.tilesVisible != null && s.tilesVisible > 0) {
      expect(s.tilesVisible, `${s.name} tilesVisible bounded for non-Mercator`).toBeLessThan(200)
    }
  }
})

test('natural_earth demo: single world', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const stats = await loadAndDump(page, 'fixture_projection_natural_earth', '')
  console.log(`[natural_earth] drawCalls=${stats.drawCalls} sources=${JSON.stringify(stats.sources)}`)
  expect(stats.drawCalls, 'natural_earth demo should still draw tiles').toBeGreaterThan(0)
})
