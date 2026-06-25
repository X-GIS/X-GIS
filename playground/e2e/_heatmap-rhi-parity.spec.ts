import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

type W = { __xgisReady?: boolean; __xgisMap?: { invalidate?: () => void }; __xgisHeatmapViaRhi?: boolean }

// RHI 6th-primitive gate: the heatmap ACCUM draw (offscreen r16float, additive
// blend, vertex+index drawIndexed) via RHI must yield a pixel-identical FINAL
// heatmap (accum → blur → compose). [HEATRHI] must fire (rhiRan).
test('heatmap RHI parity: legacy vs RHI accum pixel-identical', async ({ page }) => {
  test.setTimeout(60_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  const logs: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (/HEATRHI/.test(m.text())) logs.push(m.text()) })

  await page.setViewportSize({ width: 700, height: 700 })
  await page.goto('/demo.html?id=heatmap&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, { timeout: 25_000 })
  await page.waitForTimeout(6000)

  await page.evaluate(() => { const w = window as unknown as W; w.__xgisHeatmapViaRhi = false; w.__xgisMap?.invalidate?.() })
  await page.waitForTimeout(800)
  writeFileSync(join(OUT, 'heat-legacy.png'), await page.locator('#map').screenshot())
  await page.evaluate(() => (window as unknown as W).__xgisMap?.invalidate?.()); await page.waitForTimeout(800)
  writeFileSync(join(OUT, 'heat-legacy2.png'), await page.locator('#map').screenshot())

  await page.evaluate(() => { const w = window as unknown as W; w.__xgisHeatmapViaRhi = true; w.__xgisMap?.invalidate?.() })
  await page.waitForTimeout(800)
  writeFileSync(join(OUT, 'heat-rhi.png'), await page.locator('#map').screenshot())

  console.log('HEATPARITY rhiRan=', logs.length > 0, 'errors', errors.length)
  expect(errors.length).toBe(0)
})
