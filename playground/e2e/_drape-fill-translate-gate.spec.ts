// ═══ #2249 — fill-translate reaches the globe DRAPE path (real GPU) ═══
//
// #2240 fixed the DIRECT fill draw on both backends; _fill-translate-parity-gate
// is its witness, at a FLAT camera. On the globe the fill takes a different
// route: the vector drape bakes the fill to a tile texture and draws that on the
// raster sphere grid. The bake packs fill_translate = 0 deliberately (its ortho
// has clip.w === 1 over one tile, so a canvas-pixel NDC offset is dimensionally
// wrong there and would seam between tiles), and before #2249 the drape's own
// sphere draw never applied the offset either — so an authored fill-translate
// moved the quad on the flat map and was silently dropped on the globe.
//
// The fix folds the offset into the drape's camera MVP: clip = M·v, so shifting
// clip.xy by t·clip.w is exactly adding t·(row 3) into rows 0/1 of M.
//
// WHY THIS SPEC EXISTS SEPARATELY from the vitest gate: that one drives
// renderGlobeFills against a recorder and proves the ARITHMETIC. It cannot show
// that the offset survives to a pixel through the real bake → sphere-draw chain
// on a GPU. This is the §5 arm.
//
// WHY THE WITNESS IS MECHANISM STATE, NOT A FRAME DIFF. The obvious control —
// "the frame with the drape off must differ from the frame with it on" — cannot
// work HERE, and measuring it is how that was settled rather than assumed. Both
// arms were captured on this fixture:
//
//     drape OFF   _drapeGlobeFills false, 0 baked   46092 px   centroid 489.5
//     drape ON    _drapeGlobeFills true,  4 baked   45888 px   centroid 489.5
//
// The centroids AGREE to 0.1 px because both paths are now correct — that
// agreement is the fix working, so a "the arms must differ" assertion asks the
// drape to be WRONG, and the only separation left (204 px of rim antialias) is
// noise, not a mechanism. So the drape's participation is asserted where it is
// actually observable: `_drapeGlobeFills` + a non-empty bake cache, which is
// what `drawFills` at vector-tile-renderer.ts:4718 keys the suppression of the
// direct ECEF-chord fill draw on. When it is true, the pixels below CANNOT have
// come from the path #2240 already fixed. (The idiom is _globe-direct-overzoom-
// sharpness-gate's; §12 — an assertion carries information only if it
// distinguishes the states it tests, and the second test proves this one does.)
//
// FAIL-BEFORE, cut and measured: neutering the row-op in vector-drape-renderer.ts
// leaves the drape arm's centroid on the canvas centre — a 60 px separation the
// ±4 tolerance cannot absorb.

import { test, expect, type Page } from '@playwright/test'
import { captureMapFrame, awaitMapIdle } from './helpers/visual'

type MapWin = {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisMap?: {
    setSourceData?: (id: string, fc: unknown) => void
    invalidate?: () => void
    vtSources?: Map<string, { renderer: Record<string, unknown> }>
  }
}

/** Same quad the flat gate uses — symmetric about (0°, 0°), so an untranslated
 *  fill's screen x-centroid lands on the canvas centre. */
const QUAD = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-20, -20],
            [20, -20],
            [20, 20],
            [-20, 20],
            [-20, -20],
          ],
        ],
      },
    },
  ],
}

/** Authored in fixture-fill-translate.xgis. */
const TRANSLATE_X_PX = 60

interface Measured {
  readonly count: number
  readonly centroidX: number
  readonly width: number
  /** Did the DRAPE draw this frame — per source, as the renderer itself reports. */
  readonly draping: boolean
  readonly baked: number
}

/** Decode the captured PNG in-page: red is the only thing the fixture draws. */
async function measureFill(
  page: Page,
  png: Buffer,
): Promise<{ count: number; centroidX: number; width: number }> {
  return await page.evaluate(async (b64) => {
    const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
    let count = 0
    let sumX = 0
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < bmp.width; x++) {
        const i = (y * bmp.width + x) * 4
        // #ff3b30 with room for the sphere-rim antialias fade at the edges.
        if (d[i]! > 180 && d[i + 1]! < 90 && d[i + 2]! < 90) {
          count++
          sumX += x
        }
      }
    }
    return { count, centroidX: count > 0 ? sumX / count : -1, width: bmp.width }
  }, png.toString('base64'))
}

/** Boot the fixture on the globe with the drape held on or off, push the quad,
 *  settle, and measure both the pixels and the renderer's own drape state. */
async function runGlobe(page: Page, drape: boolean): Promise<Measured> {
  await page.goto(`/demo.html?id=fixture_fill_translate&preserve=1&adaptive=0&proj=globe#2/0/0`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, null, {
    timeout: 120_000,
  })

  // The drape bake is WebGPU-only, so a silent fallback to WebGL2 would measure
  // the DIRECT path and green this gate for the wrong reason (§12 — assert the
  // backend, never inherit it).
  const live = await page.evaluate(() => (window as unknown as MapWin).__xgisActiveBackend)
  expect(live, 'the drape path is WebGPU-only — this gate must not measure a WebGL2 fallback').toBe(
    'webgpu',
  )

  // AFTER ready, then invalidate — `_drapeGlobeFills` is recomputed on every
  // render call, so a live toggle takes effect on the next frame (the
  // _globe-vector-drape-i2 / _globe-direct-overzoom-sharpness-gate idiom). An
  // addInitScript here does NOT work: measured, both arms then came back
  // byte-identical with the drape off in each.
  //
  // __XGIS_FORCE_VECTOR_DRAPE holds the drape past the #2093 LOD ceiling
  // (`drapesAtSelectionZ`, vector-tile-renderer.ts) — its own comment names A/B
  // and sever-arm gates as its purpose.
  await page.evaluate((on) => {
    const g = globalThis as {
      __XGIS_FORCE_VECTOR_DRAPE?: boolean
      __XGIS_DISABLE_VECTOR_DRAPE?: boolean
    }
    g.__XGIS_FORCE_VECTOR_DRAPE = on
    g.__XGIS_DISABLE_VECTOR_DRAPE = !on
    ;(window as unknown as MapWin).__xgisMap?.invalidate?.()
  }, drape)

  await page.evaluate((fc) => {
    ;(window as unknown as MapWin).__xgisMap!.setSourceData!('poly', fc)
  }, QUAD)
  await awaitMapIdle(page, 90_000)

  const px = await measureFill(page, await captureMapFrame(page))
  const state = await page.evaluate(() => {
    let draping = false
    let baked = 0
    for (const [, entry] of (window as unknown as MapWin).__xgisMap?.vtSources ?? []) {
      const r = entry.renderer
      if (r['_drapeGlobeFills'] === true) draping = true
      baked += [
        ...((r['_drape'] as { baked?: Map<string, unknown> } | undefined)?.baked?.keys() ?? []),
      ].length
    }
    return { draping, baked }
  })

  // The division guard: a blank frame would otherwise hand the centroid
  // assertion a sentinel instead of a measurement.
  expect(
    px.count,
    `globe drape=${drape} painted ${px.count} red pixels — the fill did not render, so the centroid measures nothing`,
  ).toBeGreaterThan(2_000)
  return { ...px, ...state }
}

test.describe.configure({ timeout: 600_000 })

test('#2249 — an authored fill-translate moves the DRAPED fill on the globe', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  const draped = await runGlobe(page, true)

  // FIRST: prove the drape is the path these pixels came from. `drawFills` at
  // vector-tile-renderer.ts:4718 suppresses the direct ECEF-chord fill draw
  // exactly when `_drapeGlobeFills` is set, so with this true the centroid below
  // cannot be the #2240 path standing in for the one #2249 fixes.
  expect(
    draped.draping,
    'no source reports _drapeGlobeFills — the drape did not draw this frame, so the centroid ' +
      'assertion below would be measuring the direct ECEF-chord fill that #2240 already fixed',
  ).toBe(true)
  expect(
    draped.baked,
    'the drape flag is on but the bake cache is empty — nothing was baked, so the fill on screen ' +
      'did not come through the bake → sphere-draw chain this gate exists to cover',
  ).toBeGreaterThan(0)

  const expected = draped.width / 2 + TRANSLATE_X_PX
  expect(
    Math.abs(draped.centroidX - expected),
    `draped fill centroid ${draped.centroidX.toFixed(1)} px, expected ${expected} ` +
      `(canvas centre ${draped.width / 2} + the authored fill-translate-x-${TRANSLATE_X_PX}). ` +
      `A centroid at the centre is the #2249 defect: the drape's sphere draw never applied the offset.`,
    // ±4 absorbs the sphere-rim antialias the colour test half-counts; the
    // failure this separates from a pass is 60 px wide.
  ).toBeLessThan(4)

  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
})

test('#2249 witness — the drape state above distinguishes the two paths', async ({ page }) => {
  // Without this, `_drapeGlobeFills === true` in the test above could be a
  // constant of this fixture rather than a consequence of the toggle, and an
  // assertion that is true in every state carries no information (§12). The OFF
  // arm must report the OPPOSITE state — and it renders the fill either way, so
  // this also shows the flag is selecting a path, not disabling the layer.
  const off = await runGlobe(page, false)

  expect(
    { draping: off.draping, baked: off.baked },
    `with __XGIS_DISABLE_VECTOR_DRAPE set the renderer still reports draping=${off.draping} / ` +
      `${off.baked} baked tiles — the toggle does not move _drapeGlobeFills, so the drape-state ` +
      `assertion in the test above is a constant and proves nothing about which path drew`,
  ).toEqual({ draping: false, baked: 0 })
})
