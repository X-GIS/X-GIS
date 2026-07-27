// London Eye (OFM Liberty, 3D) render probe.
//
// The London Eye is mapped in OSM as ~145 `building:part` pieces at
// z14 — each a MULTIPOLYGON of 2..11 disjoint exterior rings (3..10
// points each) with a non-zero `render_min_height` (the wheel rim /
// spokes / capsules float 1..132 m above the ground). Liberty's
// `building-3d` layer extrudes them via
// `fill-extrusion-base: ["get","render_min_height"]`.
//
// Captures MapLibre vs X-GIS at the same camera so the divergence can
// be localised.
//
// Browser: https://localhost:3000/compare.html?style=openfreemap-liberty#17.5/51.50332/-0.11954/0/60

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { installOfflineProxy } from './helpers/offline-proxy'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__debug-london-eye__')
mkdirSync(OUT, { recursive: true })

const STYLE = process.env.EYE_STYLE ?? 'liberty-buildings-only'

const VIEWS = [
  { id: 'eye-z17-pitch0', hash: '#17/51.50332/-0.11954/0/0' },
  { id: 'eye-z16-pitch0', hash: '#16/51.50332/-0.11954/0/0' },
  { id: 'eye-z15-pitch0', hash: '#15/51.50332/-0.11954/0/0' },
  { id: 'eye-z14-pitch0', hash: '#14/51.50332/-0.11954/0/0' },
]

for (const view of VIEWS) {
  test(`london-eye ${view.id}`, async ({ page }) => {
    test.setTimeout(240_000)
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.warn('[page]', msg.text())
    })
    await installOfflineProxy(page, { cacheDir: join(HERE, '__net-cache__') })
    await page.setViewportSize({ width: 1000, height: 800 })
    await page.goto(`/compare.html?style=${STYLE}${view.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
        return w.__xgisReady === true && w.__mlReady === true
      },
      null,
      { timeout: 120_000 },
    )
    await page.waitForTimeout(15_000)
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    )

    const dir = join(OUT, `${STYLE}-${view.id}`)
    mkdirSync(dir, { recursive: true })
    const mlPng = await page.locator('#ml-map canvas').first().screenshot()
    const xgPng = await page.locator('#xg-canv').screenshot()
    writeFileSync(join(dir, 'maplibre.png'), mlPng)
    writeFileSync(join(dir, 'xgis.png'), xgPng)
    const ml = PNG.sync.read(mlPng)
    const xg = PNG.sync.read(xgPng)
    const cams = await page.evaluate(() => {
      const w = window as unknown as {
        __mlMap?: {
          getCenter(): { lat: number; lng: number }
          getZoom(): number
          getPitch(): number
          getBearing(): number
          getCanvas(): HTMLCanvasElement
        }
        __xgisMap?: { getCamera(): Record<string, number> }
      }
      const ml = w.__mlMap!
      const c = ml.getCenter()
      const cam = w.__xgisMap!.getCamera()
      const R = 6378137
      return {
        ml: { lat: c.lat, lon: c.lng, zoom: ml.getZoom(), pitch: ml.getPitch() },
        mlCanvas: { w: ml.getCanvas().width, h: ml.getCanvas().height },
        xg: {
          lat: (2 * Math.atan(Math.exp(cam.centerY / R)) - Math.PI / 2) * (180 / Math.PI),
          lon: (cam.centerX / R) * (180 / Math.PI),
          zoom: cam.zoom,
          pitch: cam.pitch,
        },
      }
    })
    console.warn(
      `[london-eye ${view.id}] ml=${ml.width}x${ml.height} xg=${xg.width}x${xg.height} ` +
        JSON.stringify(cams),
    )
    expect(ml.width).toBeGreaterThan(0)
  })
}
