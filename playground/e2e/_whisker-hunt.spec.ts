// Extreme zoom on NE outer corner of fixture_stroke_outset to
// hunt for the whisker the user reported.

import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__line-regressions__')
mkdirSync(ART, { recursive: true })

test('whisker hunt 15x', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 1200 })
  await page.goto('/demo.html?id=fixture_stroke_outset&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true, null, { timeout: 15_000 },
  )
  await page.waitForTimeout(500)
  const png = await page.locator('#map').screenshot()
  const b64 = png.toString('base64')
  // Hunt each corner at very high zoom.
  for (const [name, fracX, fracY] of [
    ['NE', 0.763, 0.325],
    ['NW', 0.237, 0.325],
    ['SE', 0.763, 0.667],
    ['SW', 0.237, 0.667],
  ] as const) {
    const cropped = await page.evaluate(async ({ src, fracX, fracY }) => {
      const blob = await fetch(`data:image/png;base64,${src}`).then(r => r.blob())
      const bmp = await createImageBitmap(blob)
      const cx = Math.round(bmp.width * fracX)
      const cy = Math.round(bmp.height * fracY)
      const crop = 60, zoom = 15
      const c = document.createElement('canvas')
      c.width = crop * zoom; c.height = crop * zoom
      const ctx = c.getContext('2d')!
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(bmp, cx - crop / 2, cy - crop / 2, crop, crop, 0, 0, crop * zoom, crop * zoom)
      const b = await new Promise<Blob>(r => c.toBlob(b2 => r(b2!), 'image/png'))
      const ab = await b.arrayBuffer()
      const u8 = new Uint8Array(ab)
      let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
      return btoa(s)
    }, { src: b64, fracX, fracY })
    writeFileSync(join(ART, `whisker-${name}-15x.png`), Buffer.from(cropped, 'base64'))
  }
})
