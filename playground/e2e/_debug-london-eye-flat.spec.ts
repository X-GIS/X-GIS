// Isolate the London Eye divergence: same building footprints rendered
// (a) flat `fill`, (b) fill-extrusion with height only, (c) fill-extrusion
// with height + base. Styles are synthesised in-test and served through
// the route interceptor, so nothing lands in playground/public.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { installOfflineProxy } from './helpers/offline-proxy'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__debug-london-eye__')
mkdirSync(OUT, { recursive: true })

const base = (paint: Record<string, unknown>, type: string) => ({
  version: 8,
  name: 'eye probe',
  sources: {
    openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#f8f4f0' } },
    {
      id: 'building-probe',
      type,
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 13,
      paint,
    },
  ],
})

const STYLES: Record<string, unknown> = {
  flat: base({ 'fill-color': 'hsl(35,8%,60%)' }, 'fill'),
  'extrude-h': base(
    {
      'fill-extrusion-color': 'hsl(35,8%,60%)',
      'fill-extrusion-height': ['get', 'render_height'],
    },
    'fill-extrusion',
  ),
  'extrude-hb': base(
    {
      'fill-extrusion-color': 'hsl(35,8%,60%)',
      'fill-extrusion-height': ['get', 'render_height'],
      'fill-extrusion-base': ['get', 'render_min_height'],
    },
    'fill-extrusion',
  ),
  'extrude-flat': base(
    { 'fill-extrusion-color': 'hsl(35,8%,60%)', 'fill-extrusion-height': 0 },
    'fill-extrusion',
  ),
  // Height ~0 → the extruded draw must coincide with the flat fill. Any
  // residual offset is positional, not height-driven.
  'extrude-tiny': base(
    { 'fill-extrusion-color': 'hsl(35,8%,60%)', 'fill-extrusion-height': 0.01 },
    'fill-extrusion',
  ),
  'extrude-c10': base(
    { 'fill-extrusion-color': 'hsl(35,8%,60%)', 'fill-extrusion-height': 10 },
    'fill-extrusion',
  ),
  'extrude-c50': base(
    { 'fill-extrusion-color': 'hsl(35,8%,60%)', 'fill-extrusion-height': 50 },
    'fill-extrusion',
  ),
  'extrude-c200': base(
    { 'fill-extrusion-color': 'hsl(35,8%,60%)', 'fill-extrusion-height': 200 },
    'fill-extrusion',
  ),
  // Same as extrude-hb but translucent — isolates the fill-extrusion-opacity
  // composite (MapLibre renders the layer opaque then composites once at the
  // layer alpha; a per-fragment blend instead compounds where walls overlap).
  'extrude-op80': base(
    {
      'fill-extrusion-color': 'hsl(35,8%,60%)',
      'fill-extrusion-height': ['get', 'render_height'],
      'fill-extrusion-base': ['get', 'render_min_height'],
      'fill-extrusion-opacity': 0.8,
    },
    'fill-extrusion',
  ),
  // A low alpha is the strong discriminator for per-fragment vs
  // composite-once: two overlapping walls at 0.3 reach 0.51 coverage if each
  // blends separately, but stay at 0.3 if the layer composites once.
  'extrude-op30': base(
    {
      'fill-extrusion-color': 'hsl(35,8%,60%)',
      'fill-extrusion-height': ['get', 'render_height'],
      'fill-extrusion-base': ['get', 'render_min_height'],
      'fill-extrusion-opacity': 0.3,
    },
    'fill-extrusion',
  ),
  // Flat fill AND extrusion of the SAME features in one style: any offset
  // between the two copies is an X-GIS-internal inconsistency, no MapLibre
  // needed to see it.
  both: {
    version: 8,
    name: 'eye probe both',
    sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } },
      {
        id: 'building-flat',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 13,
        paint: { 'fill-color': '#ff0000' },
      },
      {
        id: 'building-3d',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 13,
        paint: { 'fill-extrusion-color': '#0000ff', 'fill-extrusion-height': 4 },
      },
    ],
  },
}

const HASH = process.env.EYE_HASH ?? '#16/51.50332/-0.11954/0/0'

for (const key of Object.keys(STYLES)) {
  test(`eye-probe ${key}`, async ({ page }) => {
    test.setTimeout(240_000)
    page.on('console', (m) => {
      if (m.type() === 'error') console.warn('[page]', m.text())
    })
    await installOfflineProxy(page, { cacheDir: join(HERE, '__net-cache__') })
    await page.route('https://xgis.test/**', async (route) => {
      const name = new URL(route.request().url()).pathname.replace(/^\/|\.json$/g, '')
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        body: JSON.stringify(STYLES[name]),
      })
    })
    await page.setViewportSize({ width: 1000, height: 800 })
    await page.goto(
      `/compare.html?style=${encodeURIComponent(`https://xgis.test/${key}.json`)}${HASH}`,
      { waitUntil: 'domcontentloaded' },
    )
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
    const dir = join(OUT, `probe-${key}${HASH.replace(/[#/.]/g, '_')}`)
    mkdirSync(dir, { recursive: true })
    const mlPng = await page.locator('#ml-map canvas').first().screenshot()
    const xgPng = await page.locator('#xg-canv').screenshot()
    writeFileSync(join(dir, 'maplibre.png'), mlPng)
    writeFileSync(join(dir, 'xgis.png'), xgPng)
    expect(PNG.sync.read(mlPng).width).toBeGreaterThan(0)
    console.warn(`[eye-probe ${key}] captured → ${dir}`)
  })
}
