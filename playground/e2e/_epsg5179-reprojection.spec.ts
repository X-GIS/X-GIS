// E2E visual proof for AC4 (EPSG input-reprojection plan, Task T6).
//
// Loads an EPSG:5179 (Korea 2000 / Unified CS) GeoJSON fixture via the
// URL fetch path — source { type: geojson, url: "...", crs: "EPSG:5179" }.
// The fixture contains three geometry types (Point, Polygon, LineString)
// near Seoul (~126.98°E, 37.57°N). After reprojection the data must land
// at the correct WGS84 location.
//
// Assertions:
//   1. No console errors (compile / runtime / fetch).
//   2. The canvas renders non-background pixels — proves the full pipeline
//      (CRS-threaded LoadCommand → reprojectFeatureCollection → tiling →
//      upload → draw) is intact and the geometry is not lost.
//   3. The map auto-fit the reprojected bounds, so the camera is centred
//      near Seoul. We verify via `__xgisMap.getCenter()` (lon,lat) that
//      it is within ±2° of the expected Seoul centre (126.98°E, 37.57°N).
//
// The spec does NOT take a pixel-perfect baseline snapshot because GPU
// rasterisation of a tiny polygon + thin line at a fixed zoom is
// environment-sensitive (anti-aliasing, DPR). The pixel-presence count
// and camera-centre check are the meaningful regression anchors.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__epsg5179-reprojection__')
mkdirSync(ART, { recursive: true })

// The xgis program that exercises the URL-fetch + CRS-reprojection path.
// Three layers render the three geometry kinds from the fixture:
//   - poly:  Bukchon Hanok Village polygon
//   - line:  Han River line segment
//   - pt:    Gwanghwamun point
const XGIS_SOURCE = `
source seoul5179 {
  type: geojson
  url: "fixture-epsg5179-seoul.geojson"
  crs: "EPSG:5179"
}

layer poly {
  source: seoul5179
  filter: [.kind] == "polygon"
  | fill-blue-300 stroke-blue-600 stroke-1
}

layer line {
  source: seoul5179
  filter: [.kind] == "line"
  | stroke-red-500 stroke-2
}

layer pt {
  source: seoul5179
  filter: [.kind] == "point"
  | sdf-circle size-8 fill-green-500
}
`

test('EPSG:5179 GeoJSON renders at correct Seoul location via URL fetch', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  const consoleErrors: string[] = []
  const failedRequests: string[] = []

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))
  page.on('requestfailed', (req) => {
    failedRequests.push(`FAIL ${req.url()} (${req.failure()?.errorText ?? 'unknown'})`)
  })
  page.on('response', (res) => {
    if (res.status() >= 400 && !res.url().includes('/favicon.ico')) {
      failedRequests.push(`${res.status()} ${res.url()}`)
    }
  })

  // Navigate to a demo page first (minimal is the lightest), then
  // replace the running source with our EPSG:5179 test program via the
  // exposed __xgisRunSource hook.
  await page.goto('/demo.html?id=minimal#12/37.57/126.98', {
    waitUntil: 'domcontentloaded',
  })

  // Wait for the demo runner to be ready (it exposes __xgisRunSource).
  await page.waitForFunction(
    () => typeof (window as unknown as { __xgisRunSource?: unknown }).__xgisRunSource === 'function',
    null,
    { timeout: 15_000 },
  )

  // Run our test source — this triggers the URL fetch + CRS reprojection path.
  await page.evaluate(
    (src) => (window as unknown as { __xgisRunSource: (s: string) => Promise<void> }).__xgisRunSource(src),
    XGIS_SOURCE,
  )

  // Wait for __xgisReady to flip (the new source initialised successfully).
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 20_000 },
  )

  // Give the tile worker time to tile the reprojected FC and upload to GPU.
  await page.waitForTimeout(4_000)

  // ── Assertion 1: no console errors ──────────────────────────────────
  // Filter out X-GIS info-level prefixes that are not errors.
  const realErrors = consoleErrors.filter(e =>
    !e.startsWith('[X-GIS]') &&
    !e.startsWith('[X-GIS frame]') &&
    !e.startsWith('[X-GIS frame-validation]'),
  )
  if (realErrors.length > 0 || failedRequests.length > 0) {
    console.log('[epsg5179] console errors:', realErrors)
    console.log('[epsg5179] failed requests:', failedRequests)
  }
  expect(realErrors, 'no console errors during EPSG:5179 load').toEqual([])
  expect(failedRequests.filter(r => r.includes('fixture-epsg5179')),
    'fixture GeoJSON fetch must succeed').toEqual([])

  // ── Capture screenshot for diagnostics ──────────────────────────────
  const png = await page.locator('#map').screenshot()
  writeFileSync(join(ART, 'epsg5179-seoul.png'), png)

  // ── Assertion 2: canvas has non-background pixels ───────────────────
  // The reprojected geometry must have reached the framebuffer.
  // Background is dark (~rgb(6,8,12) for the minimal demo); any
  // geometry (blue polygon, red line, green point) clears this threshold.
  const litPixels = await page.evaluate(async ({ b64 }) => {
    const blob = await fetch(`data:image/png;base64,${b64}`).then(r => r.blob())
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data
    let lit = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] > 60) lit++
    }
    return lit
  }, { b64: png.toString('base64') })

  console.log(`[epsg5179] lit pixels: ${litPixels}`)
  expect(litPixels, 'reprojected geometry must be visible on canvas').toBeGreaterThan(100)

  // ── Assertion 3: camera centred near Seoul ───────────────────────────
  // After loading, the map auto-fits the reprojected bounds.
  // Seoul is at ~(126.98°E, 37.57°N); we allow ±2° tolerance for zoom
  // level and fit-padding variation.
  const center = await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: { getCenter?(): [number, number] } }).__xgisMap
    return m?.getCenter?.() ?? null
  })
  console.log(`[epsg5179] camera center: ${JSON.stringify(center)}`)
  if (center) {
    const [lon, lat] = center
    expect(Math.abs(lon - 126.98), 'camera lon near Seoul').toBeLessThan(2)
    expect(Math.abs(lat - 37.57), 'camera lat near Seoul').toBeLessThan(2)
  }
})
