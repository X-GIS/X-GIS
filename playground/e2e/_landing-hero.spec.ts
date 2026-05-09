// Regression test for the landing-page hero map. Covers two
// failure modes seen in the wild:
//   1. clip_bounds garbage discarding most fragments (commit 28b64ae)
//   2. low-zoom GeoJSON tile-selector edge case where only one z=1
//      tile reports visible, causing the fallback parent to clip to
//      a single quadrant (visible: only Africa+Australia rendered).
// Hits the SITE Astro dev server (port 4321), not the playground.

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__landing-hero__')
mkdirSync(ART, { recursive: true })

test('landing-page hero map renders all 4 quadrants', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  await page.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const c = document.getElementById('hero-map') as HTMLCanvasElement | null
    return c && getComputedStyle(c).opacity === '1'
  }, null, { timeout: 30_000 })
  await page.waitForTimeout(2_000)

  const png = await page.locator('#hero-map').screenshot()
  writeFileSync(join(ART, 'landing-hero.png'), png)

  const stats = await page.evaluate(async () => {
    const canvas = document.getElementById('hero-map') as HTMLCanvasElement
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), 'image/png'),
    )
    if (!blob) return { error: 'no blob' }
    const buf = await blob.arrayBuffer()
    const img = new Image()
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }))
    await new Promise<void>((res, rej) => {
      img.onload = () => res(); img.onerror = () => rej(new Error('decode'))
      img.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height).data
    const w = img.width, h = img.height
    const halfW = w >> 1, halfH = h >> 1
    let q_tl = 0, q_tr = 0, q_bl = 0, q_br = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3
        if (lum > 50) {
          if (x < halfW && y < halfH) q_tl++
          else if (x >= halfW && y < halfH) q_tr++
          else if (x < halfW && y >= halfH) q_bl++
          else q_br++
        }
      }
    }
    return { w, h, q_tl, q_tr, q_bl, q_br }
  })

  // eslint-disable-next-line no-console
  console.log('[landing-hero]', stats)

  if ('error' in stats) throw new Error(stats.error as string)
  // The 1/4 bug paints only one quadrant. A healthy world map covers
  // all 4 (the hero map data spans North + South + Africa + Australia +
  // Europe + Asia). Each quadrant should have at least a small fraction
  // of its area painted with land.
  const quadMin = (stats.w * stats.h / 4) * 0.01
  expect(stats.q_tl, 'top-left has content').toBeGreaterThan(quadMin)
  expect(stats.q_tr, 'top-right has content').toBeGreaterThan(quadMin)
  expect(stats.q_bl, 'bottom-left has content').toBeGreaterThan(quadMin)
  expect(stats.q_br, 'bottom-right has content').toBeGreaterThan(quadMin)
})
