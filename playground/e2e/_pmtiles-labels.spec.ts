// Validates VTR-side label rendering. Distinct from `_auto-labels`
// (GeoJSON via rawDatasets) — this exercises the path Mapbox-
// converted styles take, where features live in VTR's tile cache
// and labels resolve from the source's PropertyTable.

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__pmtiles-labels__')
mkdirSync(ART, { recursive: true })

test('PMTiles vector-tile labels render via VTR path', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  // Florence Duomo at z=14 — ensures the `places` source-layer tiles
  // are within view (Florence PMTiles archive is bounded to the city).
  await page.goto('/demo.html?id=pmtiles_labels#14/43.7733/11.2558/0/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // PMTiles tiles fetch over the network — give them time.
  await page.waitForTimeout(4_000)

  const png = await page.locator('#map').screenshot()
  writeFileSync(join(ART, 'pmtiles-labels.png'), png)

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
    let total = 0
    for (let i = 0; i < data.length; i += 4) {
      total++
      if (data[i] >= 250 && data[i + 1] >= 250 && data[i + 2] >= 250) pureWhite++
    }
    return { pureWhite, total }
  })

  // eslint-disable-next-line no-console
  console.log('[pmtiles-labels]', stats)

  if ('error' in stats) throw new Error(stats.error as string)
  // Florence's PMTiles places layer carries dozens of POI / district
  // labels at z=14. White text fill saturates pure-255 at glyph centers.
  // The buildings layer is stone-300 (RGB ~214) so it never reaches
  // the >=250 threshold; only label fills do.
  expect(stats.pureWhite,
    `expected white text pixels (got ${stats.pureWhite}/${stats.total})`,
  ).toBeGreaterThan(50)
  const gpuErrors = errors.filter(e =>
    !e.includes('favicon') && !e.includes('Failed to load resource'),
  )
  expect(gpuErrors, 'no GPU validation errors').toEqual([])
})
