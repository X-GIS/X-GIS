/// <reference types="@webgpu/types" />
import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// #599 line-drape — globe vector LINE / polygon-OUTLINE great-circle DRAPE proof (approach B, bake→
// texture→drape, the line analogue of I2 #1022). On the globe a flat vector LINE spanning a big arc
// projects as a straight CHORD under the sphere (roads / coastlines / borders cut across the curve).
// The fix bakes each visible tile's SDF line segments INTO the same tile-local texture the fill bakes
// into (VTR.bakeTileToTexture → vector-drape-stroke.bakeTileStrokes) and drapes it on the fine raster
// sphere grid so the stroke hugs the curve. This proves it on the REAL GPU with the SAME warm tile
// set, toggling ONLY the drape via `__XGIS_DISABLE_VECTOR_DRAPE`. Order OFF→ON→OFF so the OFF↔OFF pair
// is the tile-drift floor and OFF↔ON is the drape effect (the reloc-DC0 drift-vs-drape disambiguation).
// Headed WebGPU only (the bake is WebGPU-only). `coastline` = local ne_110m coastline (constant amber
// `stroke-2`, no fill) — a line-ONLY layer, so this also exercises the indexCount===0 bake path.

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-vector-line-drape__')

type Win = Window & {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __XGIS_DISABLE_VECTOR_DRAPE?: boolean
  __xgisMap?: {
    invalidate?: () => void
    getCamera?: () => { projType?: number; globeMode?: boolean; zoom?: number }
    ctx?: { rhi?: { backend?: string } }
    vtSources?: Map<string, { renderer?: { getDrawStats?: () => { tilesVisible?: number } } }>
  }
}

const tilesVisible = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const m = (window as unknown as Win).__xgisMap
    let t = 0
    for (const s of m?.vtSources?.values() ?? [])
      t += s.renderer?.getDrawStats?.().tilesVisible ?? 0
    return t
  })

async function settle(page: import('@playwright/test').Page, ms: number): Promise<void> {
  await page.evaluate(() => (window as unknown as Win).__xgisMap?.invalidate?.())
  await page.waitForTimeout(ms)
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

async function setDrape(page: import('@playwright/test').Page, on: boolean): Promise<void> {
  await page.evaluate((disable) => {
    ;(window as unknown as Win).__XGIS_DISABLE_VECTOR_DRAPE = disable
  }, !on)
  // Two settle passes so the toggled path fully repaints before capture.
  await settle(page, 900)
  await settle(page, 700)
}

test('#599 line-drape — globe vector line/outline drapes curved, not a flat chord', async ({
  page,
}) => {
  test.setTimeout(150_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  await page.setViewportSize({ width: 900, height: 900 })

  // Globe at low zoom — z1–2 coastline segments span up to ~90° of arc, so a
  // segment near the limb cuts a large chord (the maximal signal for the fix).
  await page.goto('/demo.html?id=coastline&proj=globe#2/10/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, {
    timeout: 30_000,
  })

  const cam = await page.evaluate(() => {
    const w = window as unknown as Win
    return {
      backend: w.__xgisMap?.ctx?.rhi?.backend ?? w.__xgisActiveBackend ?? 'unknown',
      projType: w.__xgisMap?.getCamera?.().projType ?? -1,
      globeMode: w.__xgisMap?.getCamera?.().globeMode ?? false,
    }
  })
  test.skip(
    cam.backend !== 'webgpu',
    `#599 line-drape needs a headed WebGPU adapter (got ${cam.backend})`,
  )

  // Warm the tile set until it stops growing (drift-free A/B).
  let prev = -1
  for (let i = 0; i < 20; i++) {
    await settle(page, 1000)
    const t = await tilesVisible(page)
    if (t > 0 && t === prev) break
    prev = t
  }

  // OFF (chord baseline) → ON (drape) → OFF (chord again). Same warm tiles.
  await setDrape(page, false)
  const chord1 = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'flat-chord.png'), chord1)

  await setDrape(page, true)
  const curved = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'curved-drape.png'), curved)

  await setDrape(page, false)
  const chord2 = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'flat-chord-2.png'), chord2)

  console.log(
    'LINE_DRAPE',
    JSON.stringify({
      ...cam,
      tilesVisible: prev,
      chordBytes: chord1.length,
      curvedBytes: curved.length,
      chord2Bytes: chord2.length,
    }),
  )
  console.log('LINE_DRAPE pageerrors', errors.length, errors.slice(0, 3))

  expect(errors, 'no page/console errors during the line-drape A/B').toEqual([])
  expect(cam.globeMode, 'globe projection active').toBe(true)
  // Drape frame MUST differ from the chord frame: with the SAME warm tiles, only the drape toggled, so
  // a no-op line drape would leave them byte-identical (the pre-fix bug — lines drawn as ECEF chords).
  // The directional DC + the drift floor (chord1 vs chord2, ~0) is the Python §5 diff on the three
  // saved PNGs — the drift-vs-drape adjudication that proves the LINES moved (curved), not the tiles.
  expect(Buffer.compare(curved, chord1), 'curved line drape must differ from flat chord').not.toBe(
    0,
  )
})
