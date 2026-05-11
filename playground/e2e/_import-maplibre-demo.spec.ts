// End-to-end: `import "https://demotiles.maplibre.org/style.json"`
// directive in xgis is fetched, auto-detected as Mapbox v8, converted
// by convertMapboxStyle at runtime, parsed, and rendered without
// compile errors.
//
// Mirrors `_import-mapbox-style.spec.ts` but pointed at the canonical
// MapLibre demo style. The fixture also exercises the inline-Feature
// geojson source (`crimea`) which is a shape OpenFreeMap doesn't have.

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__import-maplibre-demo__')
mkdirSync(ART, { recursive: true })

test('import "maplibre demo style" loads + renders without compile errors', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  await page.goto('/demo.html?id=import_maplibre_demo#1.5/0/0/0/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // Tiles fetch over the network — give them time.
  await page.waitForTimeout(5_000)

  const png = await page.locator('#map').screenshot()
  writeFileSync(join(ART, 'import-maplibre-demo.png'), png)

  // MapLibre demo background is #D8F2FF (light blue). At global view
  // the canvas should be dominated by that fill — a compile error
  // would leave the page on whatever the prior demo painted (or pure
  // black/white from the canvas default).
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
    let nonBlack = 0
    let total = 0
    for (let i = 0; i < data.length; i += 4) {
      total++
      if (data[i] > 30 || data[i + 1] > 30 || data[i + 2] > 30) nonBlack++
    }
    return { nonBlack, total }
  })

  // eslint-disable-next-line no-console
  console.log('[import-maplibre-demo]', stats)

  if ('error' in stats) throw new Error(stats.error as string)
  // Most pixels should be non-black — the bg color alone fills 100%
  // of pixels with #D8F2FF.
  expect(stats.nonBlack / stats.total,
    `expected mostly non-black canvas (MapLibre bg); got ${stats.nonBlack}/${stats.total}`,
  ).toBeGreaterThan(0.9)

  // No compile errors from the converter / parser.
  const compileErrors = errors.filter(e =>
    e.includes('Unexpected character') ||
    e.includes('Expected utility name') ||
    e.includes('parse error'),
  )
  expect(compileErrors, 'no compile errors from imported MapLibre style').toEqual([])
})
