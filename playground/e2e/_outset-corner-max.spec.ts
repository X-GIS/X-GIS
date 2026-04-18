import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__line-regressions__')
mkdirSync(ART, { recursive: true })

test('outset corner 8x', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1200, height: 1200 })
  await page.goto('/demo.html?id=fixture_stroke_outset&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true, null, { timeout: 15_000 },
  )
  await page.waitForTimeout(500)
  const png = await page.locator('#map').screenshot()
  const b64 = png.toString('base64')
  const cropped = await page.evaluate(async (src) => {
    const blob = await fetch(`data:image/png;base64,${src}`).then(r => r.blob())
    const bmp = await createImageBitmap(blob)
    // Target the NE outer corner. Square is centered so NE corner at
    // approximately (0.62, 0.38) of the viewport. Zoom in tight.
    const cx = Math.round(bmp.width * 0.625)
    const cy = Math.round(bmp.height * 0.375)
    const crop = 50, zoom = 10
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
  }, b64)
  writeFileSync(join(ART, 'outset-corner-8x.png'), Buffer.from(cropped, 'base64'))
})
