// ═══ fill-translate must reach the shader, and reach it the SAME on both backends (#2240) ═══
//
// `fill-translate` offsets a fill by an authored pixel amount. Three sites in
// vector-tile-renderer.ts pack the two uniform slots that carry it, and before
// #2240 only render() (WebGPU) derived a value — the WebGL2 twins
// renderFillsRhi / renderLinesRhi wrote an unconditional 0. So an authored
// offset moved the fill on WebGPU and was silently dropped on WebGL2.
//
// WHY THIS GATE IS NOT A CROSS-BACKEND DIFF. Parity alone is satisfiable by
// breaking the good arm: the day WebGPU also drops the offset, a "the two
// backends agree" assertion goes GREEN on a fill that no longer moves at all
// (CLAUDE.md §12 — an assertion carries information only if it distinguishes
// the states it tests). So each backend is measured against the ABSOLUTE
// expected position first, and agreement is asserted on top of that.
//
// THE MEASUREMENT. The fixture is one solid #ff3b30 quad and nothing else, and
// the spec pushes geometry that is symmetric about (0°, 0°) with the camera at
// #3/0/0 — Web Mercator's x is linear in longitude and its y is an ODD function
// of latitude, so an untranslated quad's screen x-centroid lands exactly on the
// canvas centre. The authored offset is `fill-translate-x-60`, and the pack is
// `(60 * 2) / canvasWidth` NDC with canvasWidth in DEVICE pixels
// (tile-decision.ts:704, hillshade-renderer.ts:542 both divide it by dpr to get
// CSS px), so the expected centroid is `canvasWidth / 2 + 60` device px on BOTH
// backends. That number distinguishes every failure mode the parity form cannot:
// dropped on one arm, dropped on both, wrong sign, wrong magnitude.
//
// FAIL-BEFORE, measured on this fixture before the fix (§5 directional
// pixel-diff, compare-diff.py): WebGPU vs WebGL2 differed on 6.98% of the frame
// (meanAbs 8.093), and the differing pixels occupied columns 0-59 — 60 columns,
// the authored offset exactly, with every other 16-split tile at 0.0%. After the
// fix the same pair diffs 0.00% (meanAbs 0.0, all 16 tiles clean).
//
// NO STROKE on the fixture, deliberately: a polygon's outline draws through the
// LINE pipeline, whose vertex shader reads THE SAME two slots so the outline
// stays glued to its fill (shaders/dsl/line.ts:1449-1462). Mixing both consumers
// into one measurement would make a red ambiguous about which arm moved. The
// lines arm is gated at its source instead (map/src/render/fill-translate-ndc.test.ts).

import { test, expect, type Page } from '@playwright/test'
import { captureMapFrame, awaitMapIdle } from './helpers/visual'

type MapWin = {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisMap?: { setSourceData?: (id: string, fc: unknown) => void }
}

/** A quad symmetric about (0°, 0°) — see the centroid argument above. */
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
}

/** Decode the captured PNG in-page and return the red fill's pixel count and
 *  x-centroid. Red is the ONLY thing the fixture draws — no basemap, no stroke
 *  — so every matching pixel belongs to the translated quad. */
async function measureFill(page: Page, png: Buffer): Promise<Measured> {
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

/** Boot the fixture on `backend`, push the quad, settle, and measure. */
async function run(page: Page, backend: 'webgpu' | 'webgl2'): Promise<Measured> {
  const gl2 = backend === 'webgl2' ? '&forcegl2=1' : ''
  await page.goto(`/demo.html?id=fixture_fill_translate&preserve=1&adaptive=0${gl2}#3/0/0`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, null, {
    timeout: 90_000,
  })

  // Identity NEXT TO the measurement: a silent fallback to the other backend
  // would otherwise let one arm's frame stand in for both and green the gate.
  const live = await page.evaluate(() => (window as unknown as MapWin).__xgisActiveBackend)
  expect(live, `?forcegl2 must actually pin ${backend}`).toBe(backend)

  await page.evaluate((fc) => {
    ;(window as unknown as MapWin).__xgisMap!.setSourceData!('poly', fc)
  }, QUAD)
  await awaitMapIdle(page, 60_000)

  const m = await measureFill(page, await captureMapFrame(page))
  // The division guard: a blank frame would otherwise hand the centroid
  // assertion a sentinel instead of a measurement.
  expect(
    m.count,
    `${backend} painted ${m.count} red pixels — the fill did not render at all, so the centroid below measures nothing`,
  ).toBeGreaterThan(20_000)
  return m
}

test.describe.configure({ timeout: 300_000 })

test('fill-translate lands at the authored offset on WebGPU AND on WebGL2 (#2240)', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  const gpu = await run(page, 'webgpu')
  const gl2 = await run(page, 'webgl2')

  // ±3 px absorbs the edge antialias fade the colour test half-counts; the
  // failure this separates from a pass is 60 px wide.
  const expected = gpu.width / 2 + TRANSLATE_X_PX
  const TOL = 3
  expect(
    Math.abs(gpu.centroidX - expected),
    `WebGPU fill centroid ${gpu.centroidX.toFixed(1)} px, expected ${expected} (canvas centre ${gpu.width / 2} + the authored fill-translate-x-${TRANSLATE_X_PX}) — a centroid at the centre means the offset never reached the shader`,
  ).toBeLessThan(TOL)
  expect(
    Math.abs(gl2.centroidX - expected),
    `WebGL2 fill centroid ${gl2.centroidX.toFixed(1)} px, expected ${expected} — this is the #2240 defect's own signature: renderFillsRhi packing 0 leaves the quad on the canvas centre while WebGPU moves it`,
  ).toBeLessThan(TOL)

  // And the two arms agree, which no single-arm assertion covers.
  expect(
    Math.abs(gpu.centroidX - gl2.centroidX),
    `the backends disagree by ${Math.abs(gpu.centroidX - gl2.centroidX).toFixed(1)} px`,
  ).toBeLessThan(3)

  expect(errors, 'no page errors on either backend').toEqual([])
})
