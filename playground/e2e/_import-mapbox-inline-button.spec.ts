// End-to-end check for the in-app "Import Mapbox" hook
// (`window.__xgisImportMapbox`) + the convert-page hand-off, which
// convert a FULL Mapbox style to xgis TEXT and run that text.
//
// Bug shape (pre-fix): these two flows called convertMapboxStyle()
// WITHOUT an `inlineGeoJSON` collector. Inline `source.data` objects
// fell to the "no-URL stub + call setSourceData() manually" path —
// the converter even emitted a note saying the feature was dropped,
// even though the runtime supports it. Net: the polygons never drew.
//
// Fix shape: both flows now pass a collector and push each captured
// FeatureCollection via setSourceData() after runSource(). (The xgis
// text itself can't embed inline data — the DSL has no inline-data
// form — so the push is the transport.)
//
// This spec drives __xgisImportMapbox with the same inline-GeoJSON
// fixture the runtime-import spec uses and asserts the rose-600 fill
// renders. Without the fix the canvas is navy-only. Sibling of
// _inline-geojson-import.spec.ts (which covers the `import "url"`
// runtime path).

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__import-mapbox-inline-button__')
mkdirSync(OUT, { recursive: true })

// Style fixture colors — keep in sync with
// playground/public/sample-mapbox-with-inline-geojson.json.
const FILL_RGB: [number, number, number] = [225, 29, 72] // #e11d48 rose-600
const BG_RGB: [number, number, number] = [15, 23, 42] // #0f172a slate-900
const TOL = 35 // fill-opacity 0.85 over navy bg darkens the rose; matches
// the runtime-import spec's tolerance.

test.describe('Mapbox import hook — inline GeoJSON auto-push', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('__xgisImportMapbox renders inline FeatureCollection without manual setSourceData', async ({
    page,
  }) => {
    test.setTimeout(60_000)

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })

    // Camera over the Seoul box (same framing as the runtime-import
    // spec). The hash positions the camera at boot; __xgisImportMapbox
    // honours it (the style declares no center/zoom).
    await page.goto('/demo.html#7/37.5/127', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __xgisImportMapbox?: unknown }).__xgisImportMapbox ===
        'function',
      null,
      { timeout: 30_000 },
    )

    // Fetch the inline-GeoJSON fixture and drive the import hook.
    await page.evaluate(async () => {
      const resp = await fetch('/sample-mapbox-with-inline-geojson.json')
      const json = await resp.text()
      ;(window as unknown as { __xgisImportMapbox: (j: string) => void }).__xgisImportMapbox(json)
    })

    // GeoJSON sources compile async (worker-pool parts + tileSet) after
    // the import runs. Wait for a non-empty GPU cache before sampling.
    await page.waitForFunction(
      () => {
        const map = (window as unknown as { __xgisMap?: { vtSources?: Map<string, unknown> } })
          .__xgisMap
        if (!map?.vtSources) return false
        for (const entry of map.vtSources.values()) {
          const r = entry as { renderer?: { getCacheSize?: () => number } }
          if ((r.renderer?.getCacheSize?.() ?? 0) > 0) return true
        }
        return false
      },
      null,
      { timeout: 20_000 },
    )
    await page.evaluate(
      () =>
        new Promise<void>((r) => {
          let n = 0
          const loop = () => {
            if (++n >= 6) r()
            else requestAnimationFrame(loop)
          }
          requestAnimationFrame(loop)
        }),
    )

    const result = await page.evaluate(
      async ({ fill, _bg, tol }) => {
        const canvas = document.getElementById('map') as HTMLCanvasElement
        const blob = await new Promise<Blob | null>((res) =>
          canvas.toBlob((b) => res(b), 'image/png'),
        )
        if (!blob) return { error: 'canvas.toBlob returned null' }
        const bitmap = await createImageBitmap(blob)
        const off = new OffscreenCanvas(bitmap.width, bitmap.height)
        const ctx = off.getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
        const total = data.length / 4
        let fillCount = 0
        const sums = [0, 0, 0]
        for (let i = 0; i < data.length; i += 4) {
          sums[0] += data[i]
          sums[1] += data[i + 1]
          sums[2] += data[i + 2]
          if (
            Math.abs(data[i] - fill[0]) <= tol &&
            Math.abs(data[i + 1] - fill[1]) <= tol &&
            Math.abs(data[i + 2] - fill[2]) <= tol
          )
            fillCount++
        }
        return {
          fillFraction: fillCount / total,
          meanRGB: [
            Math.round(sums[0] / total),
            Math.round(sums[1] / total),
            Math.round(sums[2] / total),
          ] as [number, number, number],
        }
      },
      { fill: FILL_RGB, bg: BG_RGB, tol: TOL },
    )

    if ('error' in result) throw new Error(result.error as string)

    const png = await page.locator('#map').screenshot()
    writeFileSync(join(OUT, 'inline-button.png'), png)
    writeFileSync(join(OUT, 'pixel-stats.json'), JSON.stringify(result, null, 2))
    console.log(
      `[import-inline-button] fill=${(result.fillFraction * 100).toFixed(2)}% mean=rgb(${result.meanRGB.join(',')})`,
    )

    expect(
      result.fillFraction,
      `Inline GeoJSON didn't render via __xgisImportMapbox: fill fraction = ${(result.fillFraction * 100).toFixed(2)}% ` +
        `(expected > 0.2 %). Mean canvas rgb(${result.meanRGB.join(',')}); if close to rgb(${BG_RGB.join(',')}) the ` +
        `inline FeatureCollection was dropped — the import hook isn't threading the inlineGeoJSON collector / pushing it ` +
        `via setSourceData after runSource.`,
    ).toBeGreaterThan(0.002)

    const realErrors = errors.filter(
      (e) => !e.includes('vite/dist/client') && !e.includes('[X-GIS pass:'),
    )
    expect(realErrors, `Console / page errors during import: ${realErrors.join('; ')}`).toEqual([])
  })
})
