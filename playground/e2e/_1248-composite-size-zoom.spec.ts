// #1248 — a composite `size-[step(.w, …) * interpolate(zoom, …)]` binding
// tracks the camera zoom LIVE on the vector-tile point path: geojson sources
// (inline or url) tile through VirtualPMTiles, and `flushTilePointsRhi`
// re-evaluates `show.sizeExpr` per feature EVERY FRAME with the live
// `cameraZoom` in the eval props (point-renderer.ts). This spec pins that
// behaviour so a future refactor that freezes the product at layer build (the
// legacy direct `addLayer` path evaluates per-feature sizes once) reddens.
//
// Scene: three points with .w = 1/2/3 → step radii 6/10/14, ramp 0.5@z1 → 1@z4.
// At z2 (ramp 0.666) and z4 (ramp 1) each dot's measured diameter must grow by
// ≈ ×1.5 while the per-feature ordering d(w3) > d(w2) > d(w1) holds at BOTH
// zooms — flat sizes (dropped feature tiers) or frozen sizes (dead ramp) both
// redden.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '__1248-composite-size__')

const SRC = `xgis 1

source pts {
  type: geojson
  data: { "type": "FeatureCollection", "features": [
    { "type": "Feature", "properties": { "w": 1 }, "geometry": { "type": "Point", "coordinates": [-10, 0] } },
    { "type": "Feature", "properties": { "w": 2 }, "geometry": { "type": "Point", "coordinates": [0, 0] } },
    { "type": "Feature", "properties": { "w": 3 }, "geometry": { "type": "Point", "coordinates": [10, 0] } }
  ] }
}

layer dots {
  source: pts
  | fill-rose-500
  | size-[step(.w, 6, 2, 10, 3, 14) * interpolate(zoom, 1, 0.5, 4, 1)]
}
`

type Win = Window & {
  __xgisReady?: boolean
  __xgisMap?: {
    invalidate?: () => void
    markCameraPositioned?: () => void
    project?: (p: [number, number]) => [number, number] | null
    getCamera?: () => { zoom: number; maxZoom: number; centerX: number; centerY: number }
  }
}

const LONS = [-10, 0, 10]

async function setZoom(page: import('@playwright/test').Page, z: number): Promise<void> {
  await page.evaluate((zoom) => {
    const m = (window as unknown as Win).__xgisMap!
    const c = m.getCamera!()
    c.zoom = zoom
    c.centerX = 0
    c.centerY = 0
    m.markCameraPositioned?.()
    m.invalidate?.()
  }, z)
  await page.waitForTimeout(2000)
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

/** Diameter of each dot: the contiguous rose run along the row through the
 *  dot's projected centre (device px). */
async function measureDiameters(
  page: import('@playwright/test').Page,
  png: Buffer,
): Promise<number[]> {
  const centers = await page.evaluate((lons) => {
    const m = (window as unknown as Win).__xgisMap!
    return lons.map((lon) => m.project!([lon, 0]))
  }, LONS)
  return page.evaluate(
    async ({ b64, centers }) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      const canvasEl = document.getElementById('map') as HTMLCanvasElement
      const cssW = canvasEl.getBoundingClientRect().width
      const scale = bmp.width / cssW
      const isRose = (x: number, y: number): boolean => {
        if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return false
        const i = (y * bmp.width + x) * 4
        return d[i] > 190 && d[i + 1] < 120 && d[i + 2] < 150 && d[i] - d[i + 1] > 80
      }
      return (centers as ([number, number] | null)[]).map((p) => {
        if (!p) return 0
        const cx = Math.round(p[0] * scale)
        const cy = Math.round(p[1] * scale)
        // Scan the centre row (±2 rows for AA robustness) for the widest run
        // covering cx.
        let best = 0
        for (let dy = -2; dy <= 2; dy++) {
          const y = cy + dy
          if (!isRose(cx, y)) continue
          let left = cx
          while (isRose(left - 1, y)) left--
          let right = cx
          while (isRose(right + 1, y)) right++
          best = Math.max(best, right - left + 1)
        }
        return best
      })
    },
    { b64: png.toString('base64'), centers },
  )
}

test('#1248 composite size tracks zoom live with per-feature tiers intact', async ({ page }) => {
  test.setTimeout(240_000)
  mkdirSync(OUT, { recursive: true })
  await page.setViewportSize({ width: 1100, height: 700 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

  const b64 = Buffer.from(SRC, 'utf8').toString('base64')
  await page.goto(`/demo.html?id=__import&e2e=1#src=${b64}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 30_000,
  })

  await setZoom(page, 2)
  const pngLow = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'z2.png'), pngLow)
  const dLow = await measureDiameters(page, pngLow)
  console.log(`Z2 diameters: ${JSON.stringify(dLow)}`)

  await setZoom(page, 4)
  const pngHigh = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'z4.png'), pngHigh)
  const dHigh = await measureDiameters(page, pngHigh)
  console.log(`Z4 diameters: ${JSON.stringify(dHigh)}`)

  expect(errors, 'no page errors').toEqual([])
  // Per-feature tiers hold at both zooms (scales not dropped).
  expect(dLow[2]).toBeGreaterThan(dLow[1])
  expect(dLow[1]).toBeGreaterThan(dLow[0])
  expect(dHigh[2]).toBeGreaterThan(dHigh[1])
  expect(dHigh[1]).toBeGreaterThan(dHigh[0])
  // The ramp is LIVE: z1→4 interpolates 0.5→1, so z2→z4 grows ≈ ×1.5
  // (0.666→1). Frozen sizes measure ratio ≈ 1. AA gives ±~2 px per edge, so
  // gate on a generous mid-band per dot.
  for (let i = 0; i < 3; i++) {
    const ratio = dHigh[i]! / Math.max(1, dLow[i]!)
    expect(
      ratio,
      `dot ${i} zoom ratio ${ratio.toFixed(2)} (z4 ${dHigh[i]}px / z2 ${dLow[i]}px)`,
    ).toBeGreaterThan(1.2)
    expect(ratio).toBeLessThan(1.9)
  }
})
