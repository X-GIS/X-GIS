import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

// PoC S3 (WIRE — approach B): bake a REGIONAL vector tile to a texture and drape
// it WARPED on the globe. Uses pmtiles_layered (real protomaps MVT) at a moderate
// globe zoom so firstNonEmptyCachedTile (nearest view centre) picks a front-facing
// ~45deg tile — big enough to show sphere curvature, and not the z0 world tile.
// The bake COMPOSITES every layer at the picked z/x/y so the texture shows the
// full map tile (bold), then draws it over the tile's TRUE geo bounds.
// Centre = North Atlantic (lon -25, lat 25): a northern, content-rich tile.
// Gate: the baked vector content shows as a bold GREEN patch warped on the sphere.

// NOTE: the green-pixel GATE (baked content visible + bold on the sphere) is run
// by the MAIN CONTEXT on the saved s3-globe-drape.png (decode + count green, and
// read the image directly) — the mandated real-GPU visual verification. WebGPU
// canvases read back blank via in-page drawImage, and a pngjs import here pulls a
// second @playwright/test, so the spec only captures + asserts the bake fired.
test('S3 bake+drape baked vector content warped on the globe', async ({ page }) => {
  test.setTimeout(90_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  const logs: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (/BAKEDRAPE/.test(m.text())) logs.push(m.text()) })

  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.goto('/demo.html?id=pmtiles_layered&e2e=1#3/25/-25', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 25_000 },
  )
  // Switch to globe + let real MVT tiles stream in before enabling the bake.
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { setProjection?: (s: string) => void; invalidate?: () => void } }
    w.__xgisMap?.setProjection?.('globe')
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(5000)
  // Enable the bake-drape hook; bakes the nearest-centre tile (all layers) once.
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: { invalidate?: () => void }; __xgisDebugBakeDrape?: boolean }
    w.__xgisDebugBakeDrape = true
    w.__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(3000)
  writeFileSync(join(OUT, 's3-globe-drape.png'), await page.locator('#map').screenshot())

  console.log('S3 errors =', errors.length, '| bake log:', logs.join(' ; '))

  // The bake must have fired (composited tile → texture) and produced no errors.
  // Green-patch-warped-on-sphere is gated by the main context on the saved PNG.
  expect(errors.length).toBe(0)
  expect(logs.some((l) => /BAKEDRAPE/.test(l))).toBe(true)
})
