// Verifies osm_style buildings actually extrude (3D walls) at high
// pitch over Tokyo. The recent extrude refactor made `.height`
// strict — features missing the property render flat instead of
// falling back to 50 m. The demo's `extrude: .height` line was
// written when the runtime defaulted to 50, so it now produces
// flat polygons when protomaps v4 buildings lack `.height`.
//
// Captures an actual screenshot at high pitch so a regression
// (height column null after merge, building source-layer wrong,
// extrude pipeline disabled, etc.) shows up as a visual diff in
// the test artefacts.

import { test, expect } from '@playwright/test'

test('osm_style buildings render 3D walls at pitch=70 over Tokyo', async ({ page }) => {
  test.setTimeout(60_000)

  const consoleErrors: string[] = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  await page.goto('/demo.html?id=osm_style#16/35.6586/139.7454/0/70', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(8_000)

  const buf = await page.locator('#map').screenshot()
  // eslint-disable-next-line no-console
  console.log('console.errors:', consoleErrors.slice(0, 5))

  // Detect 3D-ness via vertical color bands. A flat-rendered building
  // produces a single fill colour (stone-300 ≈ #d6d3d1); a properly
  // extruded one shows distinct fill (top) + outline (stone-500
  // ≈ #78716c) on the wall edges. Sample a column of pixels and
  // count distinct colours weighted toward middle-ish brightness.
  const stats = await page.evaluate(async (b64: string) => {
    return await new Promise<{ uniqueColors: number; sampleCol: string[] }>((res) => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = img.width; c.height = img.height
        const ctx = c.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const data = ctx.getImageData(0, 0, c.width, c.height).data
        // Sample bottom-quarter where buildings should sit at high
        // pitch — they grow upward from the ground plane.
        const colors = new Set<string>()
        const sampleCol: string[] = []
        for (let y = Math.floor(c.height * 0.5); y < c.height; y += 4) {
          for (let x = 0; x < c.width; x += 4) {
            const i = (y * c.width + x) * 4
            const k = `${data[i]},${data[i+1]},${data[i+2]}`
            colors.add(k)
            if (sampleCol.length < 6 && (y === Math.floor(c.height * 0.7))) sampleCol.push(k)
          }
        }
        res({ uniqueColors: colors.size, sampleCol })
      }
      img.src = `data:image/png;base64,${b64}`
    })
  }, buf.toString('base64'))

  // eslint-disable-next-line no-console
  console.log('unique colours in lower half:', stats.uniqueColors, 'sample:', stats.sampleCol)

  await page.locator('#map').screenshot({ path: 'test-results/osm-style-pitched.png' })

  expect(consoleErrors.filter(s => !/favicon|DevTools|WebGPU adapter/.test(s))).toEqual([])
  // Lower-half should have ≥ 30 distinct colours from anti-aliasing
  // + walls + outlines + landuse — flat buildings would produce
  // significantly fewer because every fragment shares the same fill
  // hex without altitude-driven shading. Loose lower bound to
  // tolerate driver noise.
  expect(stats.uniqueColors).toBeGreaterThan(30)
})
