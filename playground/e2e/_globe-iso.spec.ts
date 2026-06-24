import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

// ISOLATION: ONE frozen baked tile drawn via drawDrape vs the surface quadtree.
// Same tile + same bake → any green-coverage difference is purely the render path.
test('iso: drawDrape vs quadtree on the SAME baked tile', async ({ page }) => {
  test.setTimeout(90_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  const logs: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (/\[ISO\]/.test(m.text())) logs.push(m.text()) })

  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.goto('/demo.html?id=pmtiles_layered&e2e=1#2.5/0/20', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true, null, { timeout: 25_000 })
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { setProjection?: (s: string) => void; invalidate?: () => void } }
    w.__xgisMap?.setProjection?.('globe')
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(11000) // full load before the bake

  // DRAPE the frozen tile.
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDebugIso?: boolean; __xgisIsoQuadtree?: boolean }
    w.__xgisDebugIso = true
    w.__xgisIsoQuadtree = false
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(2500)
  writeFileSync(join(OUT, 'iso-drape.png'), await page.locator('#map').screenshot())

  // QUADTREE the SAME frozen tile.
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisIsoQuadtree?: boolean }
    w.__xgisIsoQuadtree = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(2500)
  writeFileSync(join(OUT, 'iso-quadtree.png'), await page.locator('#map').screenshot())

  console.log('ISO', logs.join(' ; '), '| errors', errors.length)
  expect(errors.length).toBe(0)
})
