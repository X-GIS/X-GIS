// Visual smoke for multi-line labels. The demo source has cities
// with names > 7em (label-max-width-7) so each wraps to ~2 lines.

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__multiline-labels__')
mkdirSync(ART, { recursive: true })

test('multiline labels wrap at max-width', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  await page.goto('/demo.html?id=multiline_labels#1.5/0/0/0/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 20_000 },
  )
  await page.waitForTimeout(1_500)

  const png = await page.locator('#map').screenshot()
  writeFileSync(join(ART, 'multiline.png'), png)

  const pureWhite = await page.evaluate(async () => {
    const canvas = document.getElementById('map') as HTMLCanvasElement
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), 'image/png'),
    )
    if (!blob) return -1
    const url = URL.createObjectURL(blob)
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image()
      i.onload = () => res(i); i.onerror = () => rej(new Error('decode'))
      i.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height).data
    let count = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] >= 250 && data[i + 1] >= 250 && data[i + 2] >= 250) count++
    }
    return count
  })

  // eslint-disable-next-line no-console
  console.log('[multiline-labels]', { pureWhite })
  expect(pureWhite, 'expected white text pixels').toBeGreaterThan(50)
})
