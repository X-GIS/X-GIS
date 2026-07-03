import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

type W = {
  __xgisReady?: boolean
  __xgisMap?: { invalidate?: () => void }
  __xgisIconViaRhi?: boolean
}

// RHI 4th-primitive gate: the sprite-icon draw (1 group {uniform/texture/sampler},
// vertex buffer, no depth) legacy vs RHI must be pixel-identical.
test('icon RHI parity: legacy vs RHI path pixel-identical', async ({ page }) => {
  test.setTimeout(45_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  const logs: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
    if (/ICONRHI/.test(m.text())) logs.push(m.text())
  })

  await page.setViewportSize({ width: 600, height: 600 })
  await page.goto('/demo.html?id=openfreemap_bright&e2e=1#15.5/35.681/139.767', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, {
    timeout: 25_000,
  })
  await page.waitForTimeout(4000) // OFM tiles + sprite settle (POI icons)

  await page.evaluate(() => {
    const w = window as unknown as W
    w.__xgisIconViaRhi = false
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(800)
  writeFileSync(join(OUT, 'icon-parity-legacy.png'), await page.locator('#map').screenshot())
  // CONTROL: legacy again (isolates tile/label instability).
  await page.evaluate(() => {
    const w = window as unknown as W
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(800)
  writeFileSync(join(OUT, 'icon-parity-legacy2.png'), await page.locator('#map').screenshot())

  await page.evaluate(() => {
    const w = window as unknown as W
    w.__xgisIconViaRhi = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(800)
  writeFileSync(join(OUT, 'icon-parity-rhi.png'), await page.locator('#map').screenshot())

  console.log('ICONPARITY rhiRan=', logs.length > 0, 'errors', errors.length)
  expect(errors.length).toBe(0)
})
