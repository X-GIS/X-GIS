import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

// M2-2: adaptive SSE surface quadtree drape. Each resident data tile is refined
// by screen-space chord error (limb refines deeper) and draped per leaf via the
// uv-subrect primitive. Visual gate (MAIN ctx): smooth limb + correct content;
// the [SURFQT] log reports leaf count + max depth (adaptive = depth grows).
test('M2-2 SSE surface quadtree drape on the globe', async ({ page }) => {
  test.setTimeout(110_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  const logs: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (/SURFQT/.test(m.text())) logs.push(m.text()) })

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
  await page.waitForTimeout(11000) // let the FULL pmtiles set load before measuring
  // M1 reference (full per-tile drape) for a green-coverage comparison. Clear the
  // bake cache first so tiles re-bake from their NOW-fully-loaded data.
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDebugMultiDrape?: boolean; __xgisClearMultiDrapeCache?: boolean }
    w.__xgisClearMultiDrapeCache = true
    w.__xgisDebugMultiDrape = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(3000)
  writeFileSync(join(OUT, 'surfqt-m1ref.png'), await page.locator('#map').screenshot())
  // M1 + texture-rgb debug: does M1's drape SAMPLE green or black?
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDebugUvColor?: boolean }
    w.__xgisDebugUvColor = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(2000)
  writeFileSync(join(OUT, 'm1-texrgb.png'), await page.locator('#map').screenshot())
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDebugUvColor?: boolean }
    w.__xgisDebugUvColor = false
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(500)
  // M2-2 surface quadtree.
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDebugMultiDrape?: boolean; __xgisDebugSurfaceQuadtree?: boolean }
    w.__xgisDebugMultiDrape = false
    w.__xgisDebugSurfaceQuadtree = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(3000)
  writeFileSync(join(OUT, 'surfqt-globe.png'), await page.locator('#map').screenshot())

  // Adaptive bake resolution A/B: force 256px (old) vs adaptive (above) — compare
  // coastline crispness on the over-zoomed coarse tile.
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDrapeForce256?: boolean }
    w.__xgisDrapeForce256 = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(2500)
  writeFileSync(join(OUT, 'surfqt-256.png'), await page.locator('#map').screenshot())
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDrapeForce256?: boolean }
    w.__xgisDrapeForce256 = false
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(500)

  // Diagnostic: output each leaf's sampled UV as colour (r=u, g=v). Smooth
  // gradient ⇒ per-draw uniforms delivered; garbage ⇒ delivery broken.
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDebugUvColor?: boolean }
    w.__xgisDebugUvColor = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(2500)
  writeFileSync(join(OUT, 'surfqt-uv.png'), await page.locator('#map').screenshot())

  // Diagnostic: quadtree with the OPAQUE checker — solid = leaves tile fine.
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDebugSurfaceQuadtreeChecker?: boolean }
    w.__xgisDebugSurfaceQuadtreeChecker = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(2500)
  writeFileSync(join(OUT, 'surfqt-checker.png'), await page.locator('#map').screenshot())

  console.log('M2-2 errors =', errors.length, '| ', logs.join(' ; '), errors.slice(0, 3).join(' || '))
  expect(errors.length).toBe(0)
  expect(logs.some((l) => /leaves=/.test(l))).toBe(true)
})
