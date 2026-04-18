// Crop + blow up the NE corner of fixture_stroke_outset so we can
// see if the round-join circle actually touches the stroke body
// or leaves a gap.

import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__line-regressions__')
mkdirSync(ART, { recursive: true })

test('stroke-outset corner zoom', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 800, height: 800 })
  await page.goto('/demo.html?id=fixture_stroke_outset&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
  await page.waitForTimeout(600)

  const png = await page.locator('#map').screenshot()
  const b64 = png.toString('base64')
  const cropped = await page.evaluate(async (src) => {
    const blob = await fetch(`data:image/png;base64,${src}`).then(r => r.blob())
    const bmp = await createImageBitmap(blob)
    // Approximate NE corner location — fixture is a square centered in
    // the viewport; NE corner sits ~(bmp.w * 0.62, bmp.h * 0.38) ish.
    const cx = Math.round(bmp.width * 0.62)
    const cy = Math.round(bmp.height * 0.38)
    const crop = 140
    const zoom = 3
    const c = document.createElement('canvas')
    c.width = crop * zoom; c.height = crop * zoom
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(bmp, cx - crop / 2, cy - crop / 2, crop, crop, 0, 0, crop * zoom, crop * zoom)
    const b = await new Promise<Blob>(r => c.toBlob(b2 => r(b2!), 'image/png'))
    const ab = await b.arrayBuffer()
    const u8 = new Uint8Array(ab)
    let str = ''
    for (let i = 0; i < u8.length; i++) str += String.fromCharCode(u8[i])
    return btoa(str)
  }, b64)
  writeFileSync(join(ART, 'stroke-outset-NE-3x.png'), Buffer.from(cropped, 'base64'))
})
