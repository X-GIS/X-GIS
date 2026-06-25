import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

type W = { __xgisReady?: boolean; __xgisMap?: { invalidate?: () => void }; __xgisLineViaRhi?: boolean }

// RHI third-primitive gate: the SDF line main draw (instanced, 2 dynamic-offset
// bind groups, reused VTR tile layout) legacy vs RHI must be pixel-identical.
test('line RHI parity: legacy vs RHI path pixel-identical', async ({ page }) => {
  test.setTimeout(45_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  const logs: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (/LINERHI/.test(m.text())) logs.push(m.text()) })

  await page.setViewportSize({ width: 600, height: 600 })
  await page.goto('/demo.html?id=fixture_stress_all_renderers&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, { timeout: 25_000 })
  await page.waitForTimeout(4000)

  await page.evaluate(() => { const w = window as unknown as W; w.__xgisLineViaRhi = false; w.__xgisMap?.invalidate?.() })
  await page.waitForTimeout(900)
  writeFileSync(join(OUT, 'line-parity-legacy.png'), await page.locator('#map').screenshot())

  await page.evaluate(() => { const w = window as unknown as W; w.__xgisLineViaRhi = true; w.__xgisMap?.invalidate?.() })
  await page.waitForTimeout(900)
  writeFileSync(join(OUT, 'line-parity-rhi.png'), await page.locator('#map').screenshot())

  console.log('LINEPARITY rhiRan=', logs.length > 0, 'errors', errors.length)
  expect(errors.length).toBe(0)
})
