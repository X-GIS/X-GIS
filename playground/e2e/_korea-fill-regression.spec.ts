// Regression spec for the multi-visible-tile dedup bug in
// `VectorTileRenderer.renderTileKeys()`. Before commit (this file's
// fix), 4 visible z=3 tiles all sharing one z=2 parent fallback were
// folded into a single dispatch by the `renderedDraws` dedup keyed
// only on (parent, worldOff) — only the first dispatch's clip_bounds
// rect let any fragment through, the other 3 visible tiles silently
// dropped. Symptom: a polygon located in any visible tile other than
// the first-dispatched one (Korea at lon 125-128°E, while the
// first dispatch was for lon 135-180°E) drew its stroke (line layer
// has no per-tile clip) but no fill.
//
// Reproducer: pmtiles_layered demo replaced with the inline-geojson
// fixture (Korea + Tokyo polygons), camera at zoom=5 over Korea
// (38°N, 127°E). After the fix, Korea fills.
//
// Assertion: red-pixel fraction must reflect TWO filled boxes
// (Korea + Tokyo). Before fix Korea was hollow → red ~0.06 % only
// from Tokyo. After fix red ~3-5 % (Korea is the dominant box at
// this zoom).

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__korea-fill-regression__')
mkdirSync(OUT, { recursive: true })

const FILL_RGB: [number, number, number] = [225, 29, 72]   // #e11d48 rose-600
const TOL = 35

test('Korea polygon fills at z=5 — multi-visible-tile dedup regression', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 720 })

  // Swap the demo fixture's Seoul box for the Korea box for this
  // test only — the production E2E uses the smaller Seoul box for
  // assertion stability, but the dedup bug only fires when the
  // polygon spans an additional visible tile beyond the first
  // dispatched one. Korea (lon 125-128) does this; Seoul (within
  // 126-127.5) doesn't.
  await page.route('**/sample-mapbox-with-inline-geojson.json', (route) => {
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: 8,
        name: 'X-GIS Korea fill-drop regression',
        sources: {
          annotations: {
            type: 'geojson',
            data: {
              type: 'FeatureCollection',
              features: [
                { type: 'Feature', properties: { id: 'korea-box' },
                  geometry: { type: 'Polygon', coordinates: [[
                    [125.5, 37.0], [128.5, 37.0], [128.5, 39.0], [125.5, 39.0], [125.5, 37.0],
                  ]] } },
                { type: 'Feature', properties: { id: 'tokyo-box' },
                  geometry: { type: 'Polygon', coordinates: [[
                    [139.5, 35.5], [140.0, 35.5], [140.0, 36.0], [139.5, 36.0], [139.5, 35.5],
                  ]] } },
              ],
            },
          },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#0f172a' } },
          { id: 'annotation-fill', type: 'fill', source: 'annotations',
            paint: { 'fill-color': '#e11d48', 'fill-opacity': 0.85 } },
          { id: 'annotation-stroke', type: 'line', source: 'annotations',
            paint: { 'line-color': '#fef3c7', 'line-width': 2 } },
        ],
      }),
    })
  })

  await page.goto('/demo.html?id=import_mapbox_inline_geojson#5/38/127', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForFunction(() => {
    const map = (window as unknown as { __xgisMap?: { vtSources: Map<string, unknown> } }).__xgisMap
    if (!map?.vtSources) return false
    for (const entry of map.vtSources.values()) {
      const r = entry as { renderer?: { getCacheSize?: () => number } }
      if ((r.renderer?.getCacheSize?.() ?? 0) > 0) return true
    }
    return false
  }, null, { timeout: 10_000 })
  await page.evaluate(() => new Promise<void>((r) => {
    let n = 0
    const loop = () => { if (++n >= 8) r(); else requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
  }))

  const result = await page.evaluate(async ({ fill, tol }) => {
    const canvas = document.getElementById('map') as HTMLCanvasElement
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/png'))
    if (!blob) return { error: 'canvas.toBlob null' }
    const bitmap = await createImageBitmap(blob)
    const off = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    const total = data.length / 4
    let fillCount = 0
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - fill[0]) <= tol &&
          Math.abs(data[i + 1] - fill[1]) <= tol &&
          Math.abs(data[i + 2] - fill[2]) <= tol) fillCount++
    }
    return { fillFraction: fillCount / total, width: bitmap.width, height: bitmap.height }
  }, { fill: FILL_RGB, tol: TOL })

  if ('error' in result) throw new Error(result.error as string)

  const png = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'korea-z5.png'), png)
  console.log(`[korea-fill] fillFraction=${(result.fillFraction * 100).toFixed(2)}%`)

  // After fix: Korea+Tokyo together fill ~0.6 % of the viewport at
  // this zoom (mostly Korea). Before fix Korea was hollow → ~0.06 %
  // from Tokyo alone. The 10× gap gives a clean threshold at 0.3 %.
  expect(result.fillFraction,
    `Korea fill missing — fillFraction=${(result.fillFraction * 100).toFixed(2)}% (expected > 0.3 %). ` +
    `Likely a regression in renderTileKeys' renderedDraws dedup: when multiple visible tiles ` +
    `share a parent fallback, each needs its own dispatch with its own clip_bounds, so the ` +
    `dedup key must include visibleKey (not just parent + worldOff).`,
  ).toBeGreaterThan(0.003)
})
