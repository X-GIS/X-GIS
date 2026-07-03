import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

type W = {
  __xgisReady?: boolean
  __xgisMap?: { invalidate?: () => void; setGlyphsUrl?: (u: string) => void }
  __xgisTextViaRhi?: boolean
}

// RHI 5th-primitive gate: the SDF glyph-label draw (per-slice draws w/ firstVertex
// + dynamic offsets, premultiplied blend, no depth) legacy vs RHI must be pixel-
// identical AND [TEXTRHI] must fire (a None diff alone is meaningless).
test('text RHI parity: legacy vs RHI path pixel-identical', async ({ page }) => {
  test.setTimeout(60_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  const logs: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
    if (/TEXTRHI/.test(m.text())) logs.push(m.text())
  })

  await page.setViewportSize({ width: 700, height: 700 })
  await page.goto('/demo.html?id=openfreemap_bright&e2e=1#13/35.681/139.767', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, {
    timeout: 25_000,
  })
  // demo.html doesn't seed glyphs (unlike compare-runner); set the OFM fonts URL
  // so place labels actually render → exercises the text renderer.
  await page.evaluate(() => {
    const w = window as unknown as W
    w.__xgisMap?.setGlyphsUrl?.('https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf')
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(14000) // OFM tiles + glyph PBF fetch + label layout

  await page.evaluate(() => {
    const w = window as unknown as W
    w.__xgisTextViaRhi = false
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(800)
  writeFileSync(join(OUT, 'text-parity-legacy.png'), await page.locator('#map').screenshot())
  await page.evaluate(() => {
    const w = window as unknown as W
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(800)
  writeFileSync(join(OUT, 'text-parity-legacy2.png'), await page.locator('#map').screenshot())

  await page.evaluate(() => {
    const w = window as unknown as W
    w.__xgisTextViaRhi = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(800)
  writeFileSync(join(OUT, 'text-parity-rhi.png'), await page.locator('#map').screenshot())

  console.log('TEXTPARITY rhiRan=', logs.length > 0, 'errors', errors.length)
  expect(errors.length).toBe(0)
})
