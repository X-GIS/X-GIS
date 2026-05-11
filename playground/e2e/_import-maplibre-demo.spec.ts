// End-to-end: `import "https://demotiles.maplibre.org/style.json"`
// directive in xgis is fetched, auto-detected as Mapbox v8, converted
// by convertMapboxStyle at runtime, parsed, and rendered without
// compile errors.
//
// Mirrors `_import-mapbox-style.spec.ts` but pointed at the canonical
// MapLibre demo style. The fixture also exercises the inline-Feature
// geojson source (`crimea`) which is a shape OpenFreeMap doesn't have.
//
// Validation strategy — defense against silent-drop:
// A bare non-black-pixel check would pass even if every vector layer
// silently dropped and only #D8F2FF background painted. Instead we
// check (a) the canvas has > 5 distinct color buckets and (b) no
// single color dominates above 95 %. Both fail on a background-only
// render, catching the failure mode where style.json resolves but
// vector layers silently fall out of the IR.

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__import-maplibre-demo__')
mkdirSync(ART, { recursive: true })

test('import "maplibre-demo-style" loads + renders without compile errors', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text()
      // Filter network-dep noise and Vite HMR chatter — the gate is
      // PARSE / WGSL compile errors specifically. Font 404s are
      // expected (symbol layers are skipped so glyph endpoint isn't
      // hit) and so are any tile gaps in demotiles.maplibre.org.
      if (t.includes('vite/dist/client')) return
      if (t.includes('Failed to fetch') && !t.includes('style.json')) return
      if (t.includes('Failed to load resource') && t.includes('404')) return
      errors.push(t)
    }
  })

  await page.goto('/demo.html?id=import_maplibre_demo#1.5/0/0/0/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // Tiles fetch over the wire — give them time to land before the
  // canvas-content check.
  await page.waitForTimeout(8_000)

  const png = await page.locator('#map').screenshot()
  writeFileSync(join(ART, 'import-maplibre-demo.png'), png)

  const stats = await page.evaluate(async () => {
    const canvas = document.getElementById('map') as HTMLCanvasElement
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), 'image/png'),
    )
    if (!blob) return { error: 'canvas.toBlob null' }
    const bitmap = await createImageBitmap(blob)
    const off = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    let total = 0
    const colorCounts = new Map<number, number>()
    for (let i = 0; i < data.length; i += 4) {
      total++
      // Bucket by (R, G, B) coarsened to ~5 bits/channel. If one
      // bucket holds > 95 % of pixels, canvas is essentially a flat
      // fill (= broken render: background-only or worse).
      const key = (data[i] >> 3) << 10 | (data[i + 1] >> 3) << 5 | (data[i + 2] >> 3)
      colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1)
    }
    let dominant = 0
    for (const c of colorCounts.values()) if (c > dominant) dominant = c
    return {
      total,
      uniqueColorBuckets: colorCounts.size,
      dominantFraction: dominant / total,
      width: bitmap.width,
      height: bitmap.height,
    }
  })

  if ('error' in stats) throw new Error(stats.error as string)
  // eslint-disable-next-line no-console
  console.log(`[import-maplibre-demo] canvas ${stats.width}×${stats.height}  ` +
    `uniqueColorBuckets=${stats.uniqueColorBuckets}  dominantFraction=${(stats.dominantFraction * 100).toFixed(1)}%`)

  // Compile / parse errors caught here. Network failures on TILE
  // fetches (after style.json resolved) aren't fatal — style.json +
  // first paint can succeed even if some tiles drop.
  expect(errors,
    `Console / pageerror during MapLibre demo style import: ${errors.join('; ')}`,
  ).toEqual([])

  expect(stats.uniqueColorBuckets,
    `canvas appears uniform (only ${stats.uniqueColorBuckets} color buckets) — ` +
    `style.json may have rendered as an empty shell`,
  ).toBeGreaterThan(5)
  expect(stats.dominantFraction,
    `single color dominates ${(stats.dominantFraction * 100).toFixed(1)}% of pixels — ` +
    `likely background-only render with no vector layers drawn`,
  ).toBeLessThan(0.95)
})
