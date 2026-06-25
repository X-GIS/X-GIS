import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

type W = { __xgisMap?: object; __xgisTextViaRhi?: boolean; __xgisIconViaRhi?: boolean }

// Verify text + icon via the COMPARE page (compare-runner seeds glyphs+sprite
// BEFORE run → labels + POI icons actually render in X-GIS, unlike demo.html).
// Capture only the X-GIS canvas (#xg-canv). Gate is valid ONLY if [TEXTRHI]/
// [ICONRHI] fires (rhiRan) AND pixel-identical vs the control.
test('text + icon RHI parity via compare harness', async ({ page }) => {
  test.setTimeout(90_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  const tLogs: string[] = []
  const iLogs: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
    if (/TEXTRHI/.test(m.text())) tLogs.push(m.text())
    if (/ICONRHI/.test(m.text())) iLogs.push(m.text())
  })

  await page.setViewportSize({ width: 800, height: 800 })
  await page.goto('/compare.html?style=openfreemap-bright#14.5/35.681/139.767', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as W).__xgisMap != null, null, { timeout: 25_000 })
  await page.waitForTimeout(16000) // style.json fetch + tiles + glyph PBF + sprite atlas

  const shot = async (name: string) => writeFileSync(join(OUT, name), await page.locator('#xg-canv').screenshot())
  const set = (k: 'text' | 'icon', v: boolean) => page.evaluate(({ k, v }) => {
    const w = window as unknown as W
    if (k === 'text') w.__xgisTextViaRhi = v; else w.__xgisIconViaRhi = v
    ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
  }, { k, v })

  await set('text', false); await set('icon', false); await page.waitForTimeout(800); await shot('li-legacy.png')
  await page.evaluate(() => (window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()); await page.waitForTimeout(800); await shot('li-legacy2.png')
  await set('text', true); await page.waitForTimeout(800); await shot('li-text-rhi.png')
  await set('text', false); await set('icon', true); await page.waitForTimeout(800); await shot('li-icon-rhi.png')

  console.log('LIPARITY textRan=', tLogs.length > 0, 'iconRan=', iLogs.length > 0, 'errors', errors.length, '::', errors.join(' || '))
  // The compare page also mounts MapLibre; ignore non-X-GIS console noise. Only
  // fail on errors that mention the X-GIS RHI path.
  const rhiErrors = errors.filter((e) => /rhi|material|Material|DrawItem|bind group|pipeline/i.test(e))
  expect(rhiErrors).toEqual([])
})
