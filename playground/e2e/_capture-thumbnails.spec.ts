// Manual capture spec — generates one JPG per gallery demo for the
// site/examples gallery cards. NOT part of the CI test suite (the
// leading `_` opts it out of the smoke run); invoke explicitly with
//
//   bun run test:e2e -- _capture-thumbnails.spec.ts
//
// Output: site/public/thumbnails/<runId>.jpg, 1200×675 (16:9), q=80.
// Naming uses the registered DEMOS key (underscores), not the
// .xgis filename (hyphens), so the gallery card renderer can build
// the path with `${runId}.jpg` directly.
//
// Animation demos that look bad as a static frame are listed in
// SKIP_ANIMATED — those keep their text-only card. Adjust as new
// animations land.

import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { captureCanvas } from './helpers/visual'

// ESM doesn't expose __dirname — recreate it from import.meta.url so
// the THUMB_DIR resolves correctly regardless of where the test
// runner is invoked from.
const __filename_eq = fileURLToPath(import.meta.url)
const __dirname_eq = dirname(__filename_eq)

// Hand-curated ~51 demos that the /examples gallery surfaces. Stays
// in sync with the `categories` array in
// site/src/pages/examples.astro — when a card lands or leaves the
// gallery, update both. (A shared list would break the site → playground
// no-cycle rule we intentionally maintain.)
const GALLERY_DEMOS = [
  // Basics
  'minimal',
  'ocean_land',
  'dark',
  'styled_world',
  'inline_data',
  // multi_layer is absent: its OSM raster base needs network egress the
  // capture environment lacks, so its card is noThumb for now.
  // PMTiles + MVT
  'pmtiles_source',
  'pmtiles_layered',
  'osm_style',
  'pmtiles_only_landuse',
  'pmtiles_v4',
  // openfreemap_bright, along_path_roads and zoom_building_color are
  // deliberately absent: their cards are noThumb (live-style settle /
  // protomaps egress — see the card notes).
  // Data-driven styling
  'continent_match',
  'continent_outlines',
  'filter_gdp',
  'gdp_gradient',
  'income_match',
  'population_gradient',
  'megacities',
  'categorical',
  'vector_categorical',
  'step_and_concat',
  // Lines & strokes
  'bold_borders',
  'dashed_borders',
  'dashed_lines',
  'layered_borders',
  'line_offset',
  'line_styles',
  'pattern_lines',
  'stroke_align',
  'translucent_lines',
  'multi_layer_line',
  'bucket_order',
  // Symbols & points
  'custom_symbol',
  'custom_shapes',
  'gradient_points',
  'populated_places',
  'procedural_circles',
  'sdf_points',
  'shape_gallery',
  'heatmap',
  // Text labels (multiline_labels is absent: labels-only over black
  // reads as an empty card — noThumb)
  'layer_below_labels',
  // Animation
  'animation_pulse',
  'animation_showcase',
  // Zoom behavior
  'zoom',
  'zoom_lod',
  // Interaction & camera
  'picking_demo',
  'mouse_position',
  'color_switcher',
  'fly_to',
  'fit_bounds',
  'jump_to_locations',
  'pitch_bearing',
  'camera_around_point',
  'animate_point_route',
  // Raster basemaps
  'raster',
  'raster_overlay',
  // satellite_map / hillshade_terrarium are absent: live-tile fetches
  // need network egress the capture environment lacks (cards noThumb).
  // Geographic compositions
  'physical_map',
  'physical_map_10m',
  'physical_map_50m',
  'night_map',
  'rivers_lakes',
  'rivers_10m',
  'states_provinces',
  'coastline',
  'coastline_10m',
  // states_10m / water_hierarchy are absent (gitignored ne_10m_* data),
  // as is coverage_bathymetry (colour-ramp draw is the #1158 headed
  // gate-3 item) — their cards are noThumb until a local capture.
  // Globe & 3D
  'globe_extrusion',
]

// Resolve once so multiple specs running in parallel don't all do
// directory creation at the same time.
const THUMB_DIR = join(__dirname_eq, '..', '..', 'site', 'public', 'thumbnails')
mkdirSync(THUMB_DIR, { recursive: true })

test.describe.configure({ mode: 'parallel' })

test.describe('Capture demo thumbnails for site/examples gallery', () => {
  // Larger viewport than the smoke 1280×720: gives the gallery card a
  // bit more pixel headroom for retina downscaling. The screenshot
  // crop is taken at 1200×675 (16:9) regardless of viewport.
  test.use({ viewport: { width: 1280, height: 720 } })

  for (const id of GALLERY_DEMOS) {
    test(`thumbnail: ${id}`, async ({ page }) => {
      // PMTiles demos pull from external CORS-restricted hosts via
      // the dev server's proxy; if that path doesn't connect within
      // the timeout the spec still emits whatever the canvas painted
      // (often the background color + nothing else) — better than
      // hanging the whole capture run. SwiftShader (XGIS_SOFTWARE_GPU=1)
      // rasterizes on the CPU, so tile-heavy demos need a longer leash.
      test.setTimeout(process.env.XGIS_SOFTWARE_GPU === '1' ? 120_000 : 45_000)

      // Demos that load from external archives or rely on a city-
      // scale view need an explicit camera hash — without one the
      // fit-to-bounds default lands at world view and the thumbnail
      // is mostly empty grid. Hashes match the gallery-demos
      // `defaultHash` entries.
      const HASH_OVERRIDE: Record<string, string> = {
        pmtiles_source: '#13/43.77/11.25',
        pmtiles_layered: '#14/35.68/139.76',
        osm_style: '#17/40.7580/-73.9855/0/75',
        pmtiles_only_landuse: '#12/35.68/139.76',
        pmtiles_v4: '#3/30/0',
        openfreemap_bright: '#14/35.68/139.76',
        along_path_roads: '#14/35.68/139.76',
        zoom_building_color: '#15.5/40.712/-74.006',
      }
      const hash = HASH_OVERRIDE[id] ?? ''
      await page.goto(`/demo.html?id=${id}${hash}`, { waitUntil: 'domcontentloaded' })

      // The #1226 editor-collapse tab hugs the map's left edge (and the
      // canvas edge once collapsed) — hide it so it can't bleed into the
      // 16:9 crop. Page chrome, not map content.
      await page.addStyleTag({ content: '#editor-collapse-btn { display: none !important; }' })

      // Captures after __xgisReady + 2× rAF. Animation demos are
      // sampled at frame 0 (no `elapsedMsAtLeast`) — for animations
      // that look hollow at t=0 the gallery uses noThumb=true to fall
      // back to the text card.
      const png = await captureCanvas(page, { readyTimeoutMs: 30_000 })

      // PMTiles demos fetch their archive over the network after
      // __xgisReady fires; if we screenshot immediately the canvas is
      // empty. Wait for at least one VT source to report visible
      // tiles, then re-capture.
      if (id in HASH_OVERRIDE) {
        await page
          .waitForFunction(
            () => {
              const m = (
                window as unknown as {
                  __xgisMap?: {
                    vtSources?: Map<
                      string,
                      { renderer: { getDrawStats?: () => { tilesVisible: number } } }
                    >
                  }
                }
              ).__xgisMap
              if (!m?.vtSources) return false
              for (const s of m.vtSources.values()) {
                const stats = s.renderer.getDrawStats?.()
                if (stats && stats.tilesVisible > 0) return true
              }
              return false
            },
            null,
            { timeout: 20_000 },
          )
          .catch(() => {
            /* still emit whatever painted */
          })
        await page.evaluate(
          () =>
            new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
        )
      }
      const finalPng = id in HASH_OVERRIDE ? await page.locator('#map').screenshot() : png

      // Re-encode PNG → JPG @ q=80 in the page context. Keeps the
      // pipeline node-side-dep-free (same constraint as visual.ts's
      // other helpers) and gives ~5x file size reduction over PNG
      // for photo-like rendered output.
      const jpgBuffer = await encodeJpeg(page, finalPng, 1200, 675, 0.8)
      writeFileSync(join(THUMB_DIR, `${id}.jpg`), jpgBuffer)
    })
  }
})

async function encodeJpeg(
  page: import('@playwright/test').Page,
  pngBuffer: Buffer,
  targetW: number,
  targetH: number,
  quality: number,
): Promise<Buffer> {
  const b64Out = await page.evaluate(
    async ({ b64, w, h, q }) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      // cover-fit: scale + center-crop the source so the thumbnail
      // never has letterbox bars regardless of source canvas shape.
      const srcAspect = bmp.width / bmp.height
      const dstAspect = w / h
      let sx = 0,
        sy = 0,
        sw = bmp.width,
        sh = bmp.height
      if (srcAspect > dstAspect) {
        // source wider — crop horizontally
        sw = Math.round(bmp.height * dstAspect)
        sx = Math.round((bmp.width - sw) / 2)
      } else if (srcAspect < dstAspect) {
        // source taller — crop vertically
        sh = Math.round(bmp.width / dstAspect)
        sy = Math.round((bmp.height - sh) / 2)
      }
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h)
      const out: Blob = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b!), 'image/jpeg', q),
      )
      const ab = await out.arrayBuffer()
      const u8 = new Uint8Array(ab)
      let s = ''
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
      return btoa(s)
    },
    { b64: pngBuffer.toString('base64'), w: targetW, h: targetH, q: quality },
  )
  return Buffer.from(b64Out, 'base64')
}
