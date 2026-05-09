// Visual + integration test for the SDF text overlay pipeline
// (Batch 1c). Loads the dedicated text-overlay demo, waits for the
// runtime to mark ready, then asserts that the canvas pixels show
// distinctly text-like content (white-on-stone with halo) over the
// world fill.
//
// What this catches:
//   - WGSL shader compilation errors (the runtime would still
//     report ready, but pixels would be wrong)
//   - Atlas / texture binding mismatches (no glyphs would appear)
//   - Coordinate projection bugs (labels off-screen / mis-clipped)
//   - Premultiplied-alpha blend setup (text would composite wrong)

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__text-overlay__')
mkdirSync(ART, { recursive: true })

test('text overlay: SDF labels render at city anchors', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  await page.goto('/examples/text-overlay.html', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 20_000 },
  )
  // Allow a few frames for the atlas worker to bake glyphs + the
  // text pass to upload them.
  await page.waitForTimeout(1_500)

  // Capture
  const png = await page.locator('#map').screenshot()
  writeFileSync(join(ART, 'text-overlay.png'), png)

  // Pixel analysis: count the number of WHITE-ish pixels (the text
  // fill colour, RGBA = [1, 1, 1, 1]). The countries layer is
  // stone-200 (~RGB 231, 229, 228) — close to white but distinguishable
  // by full-saturation 255s. Halo is dark-on-light so it sharpens the
  // boundary. We expect a non-zero count of pixels that are exactly
  // 255 in all channels (text fill stamps) IF the SDF threshold is
  // working. Without text, the closest stone-200 pixels never reach
  // pure 255.
  const stats = await page.evaluate(async () => {
    const canvas = document.getElementById('map') as HTMLCanvasElement
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), 'image/png'),
    )
    if (!blob) return { error: 'no blob' }
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

    let pureWhite = 0
    let nearBlack = 0
    let total = 0
    for (let i = 0; i < data.length; i += 4) {
      total++
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (r >= 250 && g >= 250 && b >= 250) pureWhite++
      else if (r <= 30 && g <= 30 && b <= 30) nearBlack++
    }
    return { pureWhite, nearBlack, total, w: img.width, h: img.height }
  })

  // eslint-disable-next-line no-console
  console.log('[text-overlay]', stats)

  if ('error' in stats) throw new Error(stats.error as string)

  // SDF text emits pure-white (RGBA 255,255,255) at glyph centres
  // where the SDF byte saturates above the edge threshold. Without
  // text rendering the canvas only shows the dark map background +
  // graticule (no full-saturation 255 channel triples). 50 pixels
  // is a deliberately low floor — even one rendered city label
  // produces hundreds; the floor catches "shader compiled but
  // wrote nothing" without flaking on minor dpr / font variations.
  expect(stats.pureWhite,
    `expected white text pixels (got ${stats.pureWhite}/${stats.total})`,
  ).toBeGreaterThan(50)

  // GPU validation errors land in `errors` because the Map's
  // popErrorScope reporters call console.error. The 404 below is
  // the unrelated countries.geojson — labels still land at correct
  // lon/lat without a base map, so the test isn't blocked by it.
  const gpuErrors = errors.filter(e =>
    !e.includes('favicon') &&
    !e.includes('Failed to load resource') &&
    !e.includes('countries.geojson'),
  )
  expect(gpuErrors, 'no GPU validation errors').toEqual([])
})
