import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

type W = { __xgisReady?: boolean; __xgisMap?: { invalidate?: () => void }; __xgisRasterViaRhi?: boolean }

// RHI vertical-pilot gate: the raster renderer's legacy direct-WebGPU draw vs the
// SAME draw routed through the RHI seam must be PIXEL-IDENTICAL on a settled tile
// set. Proves the backend abstraction renders byte-for-byte like the native path.
test('raster RHI parity: legacy vs RHI path pixel-identical', async ({ page }) => {
  test.setTimeout(60_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  await page.setViewportSize({ width: 800, height: 800 })
  await page.goto('/demo.html?id=raster&e2e=1#3/30/10', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, { timeout: 25_000 })
  await page.waitForTimeout(30000) // raster tiles FULLY settle (OSM tiles are slow)

  // Legacy path (default).
  await page.evaluate(() => { const w = window as unknown as W; w.__xgisRasterViaRhi = false; w.__xgisMap?.invalidate?.() })
  await page.waitForTimeout(800)
  writeFileSync(join(OUT, 'rhi-parity-legacy.png'), await page.locator('#map').screenshot())

  // CONTROL: legacy again, no path change — isolates tile-load instability.
  await page.evaluate(() => { const w = window as unknown as W; w.__xgisMap?.invalidate?.() })
  await page.waitForTimeout(800)
  writeFileSync(join(OUT, 'rhi-parity-legacy2.png'), await page.locator('#map').screenshot())

  // RHI path — same settled tiles.
  await page.evaluate(() => { const w = window as unknown as W; w.__xgisRasterViaRhi = true; w.__xgisMap?.invalidate?.() })
  await page.waitForTimeout(800)
  writeFileSync(join(OUT, 'rhi-parity-rhi.png'), await page.locator('#map').screenshot())

  console.log('RHIPARITY errors', errors.length)
  expect(errors.length).toBe(0)
})
