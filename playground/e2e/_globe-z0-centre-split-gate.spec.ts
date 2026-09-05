// #2500 / #2315 — globe whole-earth zoom: the tile (fill) frame and the
// point/label frame must share ONE camera centre.
//
// Fail-before (main @ 9f81dde): render-loop clamped camera.centerY to the
// equator at z < ~1 (viewport-fit bound) while centerLatDeg kept the true
// latitude, and derived the frame centre from centerY — so every tile anchor
// sat at lat 0 while the orbit matrix + points/labels used lat 45. A fill
// square and a point at the SAME lon/lat rendered 58 px apart (4,560 km ≈
// R·sin 45°) at z0; 82 px at z0.5; 0.2 px at z1 (z1 is the control arm).
//
// Witness: a red fill square + a green point at the camera centre (lat 45),
// captured chrome-free after idle; the two colour centroids must coincide.
// Style is inline geojson (no fixture file); the point is drawn AFTER the fill
// and is 8 px wide, so its centroid is measured from the pixels it covers.
import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { captureMapFrame, awaitMapIdle } from './helpers/visual'

const LAT = 45
const LON = 20
const SRC = `xgis 1

source sq {
  type: geojson
  data: { "type": "FeatureCollection", "features": [
    { "type": "Feature", "properties": {}, "geometry": { "type": "Polygon", "coordinates": [[[${LON - 6},${LAT - 6}],[${LON + 6},${LAT - 6}],[${LON + 6},${LAT + 6}],[${LON - 6},${LAT + 6}],[${LON - 6},${LAT - 6}]]] } }
  ] }
}
source pt {
  type: geojson
  data: { "type": "FeatureCollection", "features": [
    { "type": "Feature", "properties": {}, "geometry": { "type": "Point", "coordinates": [${LON},${LAT}] } }
  ] }
}
layer sq_fill { source: sq | fill-#ff0000 }
layer pt_dot { source: pt | fill-#00ff00 size-8 anchor-center }
`

function centroids(png: Buffer): { fill: [number, number] | null; point: [number, number] | null } {
  const img = PNG.sync.read(png)
  const acc = { fill: [0, 0, 0], point: [0, 0, 0] }
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      const r = img.data[i]!,
        g = img.data[i + 1]!,
        b = img.data[i + 2]!
      const k = r > 150 && g < 80 && b < 80 ? 'fill' : g > 150 && r < 80 && b < 80 ? 'point' : null
      if (!k) continue
      acc[k][0] += x
      acc[k][1] += y
      acc[k][2] += 1
    }
  const c = (k: 'fill' | 'point'): [number, number] | null =>
    acc[k][2] ? [acc[k][0] / acc[k][2], acc[k][1] / acc[k][2]] : null
  return { fill: c('fill'), point: c('point') }
}

async function frameAt(
  page: Page,
  zoom: number,
  forcegl2: boolean,
  proj: 'globe' | 'orthographic',
): Promise<Buffer> {
  await page.addInitScript((src) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'centre-split-gate')
  }, SRC)
  await page.goto(
    `/demo.html?id=__import&e2e=1&proj=${proj}&adaptive=0${forcegl2 ? '&forcegl2=1' : ''}#${zoom}/${LAT}/${LON}/0/0`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 60_000 },
  )
  await awaitMapIdle(page, 60_000)
  // Assert the backend so a silent fallback cannot green the other arm.
  const backend = await page.evaluate(
    () => (window as unknown as { __xgisActiveBackend?: string }).__xgisActiveBackend ?? 'unknown',
  )
  expect(backend).toBe(forcegl2 ? 'webgl2' : 'webgpu')
  return captureMapFrame(page, { readyTimeoutMs: 120_000, capture: 'clip' })
}

// The untilted orthographic disc shares the lat-deg centre authority (and had
// the same split: its zoom branch pinned the mirror too), so it rides the gate.
for (const forcegl2 of [false, true]) {
  test.describe(forcegl2 ? 'webgl2' : 'webgpu', () => {
    for (const [proj, zoom] of [
      ['globe', 0],
      ['globe', 0.5],
      ['globe', 1],
      ['orthographic', 0],
      ['orthographic', 1],
    ] as const) {
      test(`fill and point at the camera centre coincide — ${proj} z${zoom} lat ${LAT}`, async ({
        page,
      }) => {
        test.setTimeout(180_000)
        const { fill, point } = centroids(await frameAt(page, zoom, forcegl2, proj))
        expect(fill, 'fill square not rendered').not.toBeNull()
        expect(point, 'point not rendered').not.toBeNull()
        const dx = fill![0] - point![0]
        const dy = fill![1] - point![1]
        console.log(
          `[centre-split ${proj} z${zoom} ${forcegl2 ? 'gl2' : 'gpu'}] fill=(${fill![0].toFixed(1)},${fill![1].toFixed(1)}) point=(${point![0].toFixed(1)},${point![1].toFixed(1)}) Δ=(${dx.toFixed(1)},${dy.toFixed(1)})`,
        )
        // Pre-fix: Δy = −58 px at z0, −82 px at z0.5. The square's centroid
        // vs the point's: sub-pixel apart from the centroid of a foreshortened
        // square, so 2 px is a wide margin.
        expect(Math.hypot(dx, dy)).toBeLessThan(2)
      })
    }
  })
}
