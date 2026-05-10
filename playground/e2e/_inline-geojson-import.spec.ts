// End-to-end check for the importer's inline-GeoJSON auto-push path.
//
// Bug shape (pre-fix): a Mapbox style with `"data": {FC}` inline got
// converted to a no-URL geojson stub that the host had to populate via
// `map.setSourceData()` manually. If the host didn't know to call it,
// the inline features never rendered.
//
// Fix shape: convertMapboxStyle now accepts an `inlineGeoJSON` Map
// collector; resolveImportsAsync threads it through; map.run seeds
// rawDatasets directly after Promise.all. The first rebuildLayers
// includes the features automatically.
//
// What this spec asserts: the demo at `import_mapbox_inline_geojson`
// renders red pixels (the inline polygon's #e11d48 fill) on a dark
// navy background. Without the fix, the canvas would be navy-only.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__inline-geojson-import__')
mkdirSync(OUT, { recursive: true })

// Style fixture colors — keep in sync with
// playground/public/sample-mapbox-with-inline-geojson.json.
const FILL_RGB: [number, number, number] = [225, 29, 72]    // #e11d48 rose-600
const BG_RGB: [number, number, number]   = [15, 23, 42]     // #0f172a slate-900
const TOL = 35   // permissive — fill-opacity 0.85 over navy bg
                  // shifts toward dark red, so per-channel diffs vs
                  // pure #e11d48 land in the 20-30 range. 35 keeps
                  // headroom for anti-aliasing.

test.describe('Mapbox style import — inline GeoJSON auto-push', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('inline FeatureCollection renders without a manual setSourceData call', async ({ page }) => {
    test.setTimeout(60_000)

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })

    // Zoom 7 over the Seoul box: the 0.9°×0.4° polygon occupies
    // a few percent of the canvas at this scale — comfortable margin
    // above the 1 % assertion floor regardless of DPI / viewport
    // variance.
    await page.goto(
      '/demo.html?id=import_mapbox_inline_geojson#7/37.5/127',
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 },
    )
    // GeoJSON sources go through an async worker-pool compile (parts +
    // tileSet) that lands AFTER `__xgisReady` flips. Wait for the
    // shared geojson VT source to have non-empty GPU cache before
    // sampling pixels. 5 s timeout matches existing geojson demos.
    await page.waitForFunction(() => {
      const map = (window as unknown as { __xgisMap?: { vtSources: Map<string, unknown> } }).__xgisMap
      if (!map?.vtSources) return false
      for (const entry of map.vtSources.values()) {
        const r = entry as { renderer?: { getCacheSize?: () => number } }
        if ((r.renderer?.getCacheSize?.() ?? 0) > 0) return true
      }
      return false
    }, null, { timeout: 10_000 })
    // Extra rAFs so the first draw with the populated cache lands.
    await page.evaluate(() => new Promise<void>((r) => {
      let n = 0
      const loop = () => { if (++n >= 6) r(); else requestAnimationFrame(loop) }
      requestAnimationFrame(loop)
    }))

    // Capture canvas + count fill-color vs bg pixels in the page so
    // we read what the user would see (WebGPU readback path, same as
    // production screenshot tooling).
    const result = await page.evaluate(async ({ fill, bg, tol }) => {
      const canvas = document.getElementById('map') as HTMLCanvasElement
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob((b) => res(b), 'image/png'))
      if (!blob) return { error: 'canvas.toBlob returned null' }
      const bitmap = await createImageBitmap(blob)
      const off = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = off.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
      const total = data.length / 4
      let fillCount = 0
      let bgCount = 0
      // Histogram top channel-by-channel for diagnostics if the
      // assertion misses (e.g., the converter emitted a different
      // color → assertion fails but we want to see what we got).
      const sums = [0, 0, 0]
      for (let i = 0; i < data.length; i += 4) {
        sums[0] += data[i]
        sums[1] += data[i + 1]
        sums[2] += data[i + 2]
        const dr = Math.abs(data[i] - fill[0])
        const dg = Math.abs(data[i + 1] - fill[1])
        const db = Math.abs(data[i + 2] - fill[2])
        if (dr <= tol && dg <= tol && db <= tol) fillCount++
        else {
          const br = Math.abs(data[i] - bg[0])
          const bgg = Math.abs(data[i + 1] - bg[1])
          const bb = Math.abs(data[i + 2] - bg[2])
          if (br <= tol && bgg <= tol && bb <= tol) bgCount++
        }
      }
      const meanR = Math.round(sums[0] / total)
      const meanG = Math.round(sums[1] / total)
      const meanB = Math.round(sums[2] / total)
      return {
        fillFraction: fillCount / total,
        bgFraction: bgCount / total,
        otherFraction: (total - fillCount - bgCount) / total,
        meanRGB: [meanR, meanG, meanB] as [number, number, number],
        width: bitmap.width,
        height: bitmap.height,
      }
    }, { fill: FILL_RGB, bg: BG_RGB, tol: TOL })

    if ('error' in result) throw new Error(result.error as string)

    // Save artifact for visual diagnosis.
    const png = await page.locator('#map').screenshot()
    writeFileSync(join(OUT, 'inline-geojson.png'), png)
    writeFileSync(join(OUT, 'pixel-stats.json'), JSON.stringify(result, null, 2))

    console.log(`[inline-geojson] fill=${(result.fillFraction * 100).toFixed(2)}% bg=${(result.bgFraction * 100).toFixed(2)}% mean=rgb(${result.meanRGB.join(',')})`)

    // Assertion: inline fill must occupy a meaningful area. The
    // Seoul box at zoom 7 over center 37.5°N/127°E covers ~0.5 % of
    // the canvas (about 3500 fill pixels on 860×720). Floor at 0.2 %
    // is well above the broken-path noise floor (~0.06 % if no
    // polygon at all draws — only the cream stroke pixels match
    // within a wide tolerance) but generous against AA / DPI shifts.
    expect(result.fillFraction,
      `Inline GeoJSON didn't render: fill-pixel fraction = ${(result.fillFraction * 100).toFixed(2)}% ` +
      `(expected > 0.2 %). Mean canvas color rgb(${result.meanRGB.join(',')}); if it's close to ` +
      `rgb(${BG_RGB.join(',')}) then the inline FeatureCollection was dropped during import — ` +
      `convertMapboxStyle's inlineGeoJSON collector is not being threaded through, or map.run ` +
      `is not seeding rawDatasets after the source-load Promise.all.`,
    ).toBeGreaterThan(0.002)

    // No console errors / page errors — covers parse failures inside
    // the converted xgis text (spaces in source ids, unsupported paint
    // properties, etc.) which would surface as overlay errors.
    const realErrors = errors.filter(e =>
      !e.includes('vite/dist/client') &&  // dev-server HMR noise
      !e.includes('[X-GIS pass:'),         // pass-debug overlay (informational)
    )
    expect(realErrors,
      `Console / page errors during import: ${realErrors.join('; ')}`,
    ).toEqual([])
  })
})
