// ═══ #2291 — per-SLICE opacity survives the globe vector DRAPE (real GPU) ═══
//
// The drape's per-show opacity lived in a shared GLOBAL uniform that
// RasterDraper.draw rewrites per slice-layer. On WebGPU queue.writeBuffer is
// deferred to the single per-frame submit, so last-writer-wins: every
// drape-eligible slice of one source painted with the LAST slice's opacity. The
// fix moves the value onto the per-tile lane (tile_ecef_center.w) that #1142 had
// already made per-slice.
//
// WHY THIS SPEC EXISTS SEPARATELY from the vitest gate: that one drives the
// packer and proves the LANE carries the value. It cannot show the value
// survives the real bake -> sphere-draw chain to a pixel on a GPU. This is the
// §5 arm.
//
// WHY THE FIXTURE IS SHAPED THE WAY IT IS — measured, not assumed. The first
// version of this gate used two FILTERED layers over disjoint quads and split
// the frame by x. It passed WITH THE FIX CUT: map.ts:3657 gives a filtered layer
// its OWN VT source, hence its own VectorDrapeRenderer and its own global
// uniform, so that scene has one slice per source and cannot reach the defect at
// all. The fixture now uses two UNFILTERED layers, which share the source — the
// multi-slice shape the bug lives in. They therefore cover the SAME pixels and
// are separated by COLOUR, red under and green over, which encodes both
// opacities independently:
//
//     correct (0.9 red, then 0.2 green)  ->  r = 0.8*0.9*255 = 184, g = 51
//     both collapsed to the last (0.2)   ->  r =  0.8*0.2*255 =  41, g = 51
//     both collapsed to the first (0.9)  ->  r =  0.1*0.9*255 =  23, g = 230
//
// The measured direct-path composite is exactly 184,51,0, so the bounds below
// are centred on a measurement rather than on the arithmetic alone.
//
// WHY TWO ARMS. The drape arm alone cannot separate "per-slice opacity works"
// from "this scene happens to composite to something plausible", so the DIRECT
// path — where per-layer opacity has always been correct — is the reference. The
// gate asserts each arm lands on the correct composite AND that the two agree.

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

/** One quad spanning the visible face at #2/0/0 — both layers draw it, so every
 *  painted pixel carries BOTH opacities and no positional split is needed. */
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
            [-25, -16],
            [25, -16],
            [25, 16],
            [-25, 16],
            [-25, -16],
          ],
        ],
      },
    },
  ],
}

interface Measured {
  readonly count: number
  readonly meanR: number
  readonly meanG: number
  readonly draping: boolean
  readonly baked: number
  readonly sources: number
}

/** Decode the captured PNG in-page and average the composite over every painted
 *  pixel. Over the fixture's opaque black background the channels ARE the two
 *  authored opacities, in 8-bit units. */
async function measureComposite(
  page: Page,
  png: Buffer,
): Promise<{ count: number; meanR: number; meanG: number }> {
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
    let sumR = 0
    let sumG = 0
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]!
      const g = d[i + 1]!
      // The quad's interior, not the sphere-rim antialias fade. Keyed on GREEN
      // because the over-layer's own opacity puts green at 51 in the correct
      // state AND in the last-wins collapse, and at 230 in the first-wins one —
      // so one floor selects the interior in every state the gate has to tell
      // apart. A brightness floor does not: at 100 the last-wins collapse
      // (r = 41, g = 51) falls entirely below it and the gate reds with
      // "painted 0 pixels" instead of naming the opacity that collapsed.
      if (g > 20) {
        count++
        sumR += r
        sumG += g
      }
    }
    return { count, meanR: count ? sumR / count : -1, meanG: count ? sumG / count : -1 }
  }, png.toString('base64'))
}

/** Boot the fixture on the globe with the drape held on or off, push the quad,
 *  settle, and measure both the pixels and the renderer's own drape state. */
async function runGlobe(page: Page, drape: boolean): Promise<Measured> {
  await page.goto(`/demo.html?id=fixture_drape_opacity&preserve=1&adaptive=0&proj=globe#2/0/0`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, null, {
    timeout: 120_000,
  })

  // The drape bake is WebGPU-only, so a silent fallback to WebGL2 would measure
  // the DIRECT path in BOTH arms and green this gate for the wrong reason
  // (§12 — assert the backend, never inherit it).
  const live = await page.evaluate(() => (window as unknown as MapWin).__xgisActiveBackend)
  expect(live, 'the drape path is WebGPU-only — this gate must not measure a WebGL2 fallback').toBe(
    'webgpu',
  )

  // AFTER ready, then invalidate — `_drapeGlobeFills` is recomputed per render,
  // so a live toggle takes effect on the next frame. An addInitScript does NOT
  // work here (measured on the sibling #2249 gate: both arms then came back with
  // the drape off). __XGIS_FORCE_VECTOR_DRAPE holds the drape past the #2093 LOD
  // ceiling, which is what it documents itself as being for.
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

  const px = await measureComposite(page, await captureMapFrame(page))
  const state = await page.evaluate(() => {
    let draping = false
    let baked = 0
    let sources = 0
    for (const [key, entry] of (window as unknown as MapWin).__xgisMap?.vtSources ?? []) {
      if (key === '__synthetic_earth_surface__') continue
      sources++
      const r = entry.renderer
      if (r['_drapeGlobeFills'] === true) draping = true
      baked += [
        ...((r['_drape'] as { baked?: Map<string, unknown> } | undefined)?.baked?.keys() ?? []),
      ].length
    }
    return { draping, baked, sources }
  })

  // The division guard: a blank frame would hand the mean assertions a sentinel
  // (-1), and -1 satisfies every "< upper bound" test.
  expect(
    px.count,
    `globe drape=${drape} painted ${px.count} pixels — the fill did not render, so the means measure nothing`,
  ).toBeGreaterThan(10_000)

  // The premise the whole fixture rests on: ONE vt source carrying BOTH layers.
  // A filtered layer would get its own source, its own drape renderer and its
  // own global uniform — a scene the defect cannot reach, which is how the first
  // version of this gate came to pass with the fix cut.
  expect(
    state.sources,
    `the two layers must share ONE vt source to be two SLICES — saw ${state.sources}`,
  ).toBe(1)

  return { ...px, ...state }
}

test.describe.configure({ timeout: 600_000 })

test('#2291 — each drape-eligible fill slice keeps its OWN opacity', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))

  const off = await runGlobe(page, false)
  const on = await runGlobe(page, true)

  expect(errors, `page errors: ${errors.join(' | ')}`).toHaveLength(0)

  // The drape must actually have drawn, or the pixels came from the direct path
  // and this gate says nothing about the drape at all.
  expect(on.draping, 'the drape arm did not drape — _drapeGlobeFills is false').toBe(true)
  expect(
    on.baked,
    'the drape arm baked no tile, so nothing was drawn through the drape',
  ).toBeGreaterThan(0)
  expect(off.draping, 'the control arm draped — the toggle did not take').toBe(false)

  // Each arm lands on the correct composite. The bounds exclude BOTH collapsed
  // states by a wide margin: last-wins gives r = 41, first-wins gives r = 23 with
  // g = 230.
  for (const [name, m] of [
    ['direct', off],
    ['drape', on],
  ] as const) {
    expect(m.meanR, `${name}: red averaged ${m.meanR}, expected ~184`).toBeGreaterThan(160)
    expect(m.meanR, `${name}: red averaged ${m.meanR}, expected ~184`).toBeLessThan(205)
    expect(m.meanG, `${name}: green averaged ${m.meanG}, expected ~51`).toBeGreaterThan(38)
    expect(m.meanG, `${name}: green averaged ${m.meanG}, expected ~51`).toBeLessThan(70)
  }

  // And the drape agrees with the direct path — the fix stated as an equality, so
  // a drape that lands on the right side of every bound but by the wrong amounts
  // still fails.
  expect(Math.abs(on.meanR - off.meanR), 'drape vs direct, red').toBeLessThan(12)
  expect(Math.abs(on.meanG - off.meanG), 'drape vs direct, green').toBeLessThan(12)
})
