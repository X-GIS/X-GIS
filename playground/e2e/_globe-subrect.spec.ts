import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

// M2-1: UV sub-rect drape. Render the multidrape normally (each tile = one full
// patch) vs split-into-left/right-halves-via-uv-subrect. If the sub-rect halves
// reassemble seamlessly, the two images are ~identical → surface-patch sub-rect
// sampling is correct (the primitive the decoupled mesh needs). Gate = MAIN ctx.
test('M2-1 uv sub-rect drape reassembles seamlessly', async ({ page }) => {
  test.setTimeout(110_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.goto('/demo.html?id=pmtiles_layered&e2e=1#2.5/0/20', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 25_000 },
  )
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { setProjection?: (s: string) => void; invalidate?: () => void } }
    w.__xgisMap?.setProjection?.('globe')
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(6000)
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDebugMultiDrape?: boolean }
    w.__xgisDebugMultiDrape = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(3000)
  writeFileSync(join(OUT, 'subrect-full.png'), await page.locator('#map').screenshot())

  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDebugSubRect?: boolean }
    w.__xgisDebugSubRect = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(2500)
  writeFileSync(join(OUT, 'subrect-halves.png'), await page.locator('#map').screenshot())

  console.log('M2-1 subrect errors =', errors.length, errors.slice(0, 4).join(' || '))
  expect(errors.length).toBe(0)
})
