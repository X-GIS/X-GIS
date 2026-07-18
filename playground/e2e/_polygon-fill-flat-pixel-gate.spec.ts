// ═══ Flat-projection polygon FILL rasterisation gate (#1127) ═══
//
// THE GAP THIS CLOSES. #1127 reported that under headless Chromium + SwiftShader
// (XGIS_SOFTWARE_GPU=1, the CI-adjacent probe harness) every flat-Mercator polygon
// FILL fragment produced no output — solid `fs_fill` AND `fs_fill_pattern` alike —
// while strokes, labels and globe fills rendered fine. Existing coverage was
// vacuous on this axis: `_fill-pattern-dc0` asserts only uvResolved/draw counts (no
// pixels), `_demo-fixture-audit` SKIPS its paint threshold under SOFTWARE_GPU, and
// `_polygon-fill-flat-parity` is a COMPUTE-only position gate (#392 displacement,
// not visibility). Nothing rasterised a flat fill and asserted the interior painted
// — exactly the "assert the square actually rasterises" probe the fixture header
// (fixture-fill-pattern.xgis) demands but that was never written. So the fill could
// vanish and every gate stayed green.
//
// THE GATE. Boot the fixtures under the SAME SwiftShader harness and assert the fill
// INTERIOR actually rasterises, with a same-frame stroke-visible positive control so
// a failure means "fill missing", not "boot/raster failure":
//   • fixture_square      — solid `fill-emerald-500` interior must paint.
//   • fixture_stroke_fill — solid `fill-blue-500` + `stroke-amber-300`: the amber
//                           stroke is the RIGHT-REASON guard (raster works), the blue
//                           fill is the thing under test (must paint on that frame).
//   • fixture_fill_pattern — sprite `fill-pattern` interior must paint.
//
// STATUS at 7d0f31f (≡ 5e4b366 for the fill path — the two are byte-identical across
// polygon.ts / log-depth.ts / pipeline-factory.ts / polygon-fill-material.ts /
// gpu-shared.ts): this gate is GREEN. The #1127 invisibility does NOT reproduce in a
// current SwiftShader-WebGPU (chromium-1194) build: solid, pattern and synthetic-
// surface fills all rasterise, and the fill's frag_depth is a stable ~0.97 ∈ [0,1].
// The gate is retained as the permanent rasterisation regression fence that would
// turn red the instant a real flat-fill-invisibility lands.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__fill-pixel-gate__')
mkdirSync(OUT, { recursive: true })

const VIEW = { width: 800, height: 600 }
// Deterministic camera: the square (-40..40 lon, -30..30 lat) and the triangle both
// sit around the origin; z2 centres them with viewport margin so the frame corners
// are background and the centre [0.4,0.6] box is pure interior fill.
const CAM = { center: [0, 0] as [number, number], zoom: 2 }

interface Decoded {
  w: number
  h: number
  bg: [number, number, number]
  centre: [number, number, number]
  boxPx: number // pixels in the interior sampling box
  whole: number // non-background pixels, full frame
  interior: number // non-background pixels, centre [0.40,0.60] box
  green: number // emerald-500 solid fill
  blue: number // blue-500 solid fill
  amber: number // amber-300 stroke
  patternVividInterior: number // red/blue sprite pattern pixels in the centre box
}

async function bootAndDecode(
  page: import('@playwright/test').Page,
  id: string,
  query: string,
): Promise<{ ready: boolean; fillDraws: number; dec: Decoded }> {
  await page.setViewportSize(VIEW)
  await page.goto(`/demo.html?id=${id}${query}`, { waitUntil: 'domcontentloaded' })
  const ready = await page
    .waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 25_000 },
    )
    .then(() => true)
    .catch(() => false)
  // Deterministic framing, then let tiles settle.
  await page.evaluate((cam) => {
    ;(window as unknown as { __xgisMap?: { jumpTo?: (o: object) => void } }).__xgisMap?.jumpTo?.(
      cam,
    )
  }, CAM)
  await page.waitForTimeout(2000)

  const fillDraws = await page.evaluate(
    () => (window as unknown as { __xgisVtrFillRhiDraws?: number }).__xgisVtrFillRhiDraws ?? 0,
  )
  const png = await page.locator('#map').screenshot({ type: 'png' })
  writeFileSync(join(OUT, `${id}.png`), png)

  const dec = (await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('img'))
      img.src = url
    })
    const w = img.width
    const h = img.height
    const off = new OffscreenCanvas(w, h)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, w, h).data
    const at = (x: number, y: number): [number, number, number] => {
      const i = (y * w + x) * 4
      return [d[i]!, d[i + 1]!, d[i + 2]!]
    }
    // Background reference = the top-left corner (outside all geometry at z2).
    const bg = at(2, 2)
    const manhattan = (r: number, g: number, b: number) =>
      Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2])
    const xMin = Math.floor(w * 0.4),
      xMax = Math.floor(w * 0.6)
    const yMin = Math.floor(h * 0.4),
      yMax = Math.floor(h * 0.6)
    let whole = 0,
      interior = 0,
      green = 0,
      blue = 0,
      amber = 0,
      patternVividInterior = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const r = d[i]!,
          g = d[i + 1]!,
          b = d[i + 2]!
        const inBox = x >= xMin && x < xMax && y >= yMin && y < yMax
        if (manhattan(r, g, b) > 45) {
          whole++
          if (inBox) interior++
        }
        if (g > 120 && r < 100 && g > b) green++
        if (b > 150 && r < 120 && g < 175) blue++
        if (r > 175 && g > 135 && b < 120) amber++
        if (inBox && ((r > 150 && g < 120 && b < 120) || (b > 150 && r < 120)))
          patternVividInterior++
      }
    }
    URL.revokeObjectURL(url)
    return {
      w,
      h,
      bg,
      centre: at(Math.floor(w / 2), Math.floor(h / 2)),
      boxPx: (xMax - xMin) * (yMax - yMin),
      whole,
      interior,
      green,
      blue,
      amber,
      patternVividInterior,
    }
  }, Array.from(png))) as Decoded

  return { ready, fillDraws, dec }
}

test.describe('flat-projection polygon fill rasterises (#1127)', () => {
  test('solid fill interior paints (fixture_square, fill-emerald-500)', async ({ page }) => {
    test.setTimeout(60_000)
    const { ready, fillDraws, dec } = await bootAndDecode(page, 'fixture_square', '')
    console.log(
      `[gate square] ${dec.w}x${dec.h} box=${dec.boxPx} ready=${ready} fillDraws=${fillDraws} ` +
        `bg=${dec.bg} centre=${dec.centre} whole=${dec.whole} interior=${dec.interior} green=${dec.green}`,
    )
    // Right-reason guard: boot + the fill draw were emitted (issue evidence #1).
    expect(ready, 'fixture_square never reached __xgisReady').toBe(true)
    expect(
      fillDraws,
      'no fill draw was recorded — boot/route failure, not a fill bug',
    ).toBeGreaterThan(0)
    // THE GATE: the solid fill interior must rasterise (blank ⇒ ~0).
    expect(
      dec.interior,
      `solid fill interior produced ${dec.interior} non-bg px (fill invisible under SwiftShader)`,
    ).toBeGreaterThan(4000)
    expect(dec.green, `emerald fill produced ${dec.green} green px`).toBeGreaterThan(40000)
  })

  test('fill blank but stroke present ⇒ same-frame right-reason (fixture_stroke_fill)', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const { ready, dec } = await bootAndDecode(page, 'fixture_stroke_fill', '')
    console.log(
      `[gate stroke_fill] ${dec.w}x${dec.h} ready=${ready} bg=${dec.bg} centre=${dec.centre} ` +
        `whole=${dec.whole} blue(fill)=${dec.blue} amber(stroke)=${dec.amber}`,
    )
    expect(ready, 'fixture_stroke_fill never reached __xgisReady').toBe(true)
    // Right-reason guard, SAME frame: the amber stroke rasterises.
    expect(
      dec.amber,
      `amber stroke produced ${dec.amber} px — raster failure, not a fill bug`,
    ).toBeGreaterThan(1500)
    // THE GATE: the blue fill must rasterise on that same frame.
    expect(
      dec.blue,
      `blue fill produced ${dec.blue} px while the stroke rendered (fill invisible under SwiftShader)`,
    ).toBeGreaterThan(12000)
  })

  test('pattern fill interior paints (fixture_fill_pattern, fs_fill_pattern)', async ({ page }) => {
    test.setTimeout(60_000)
    const { ready, fillDraws, dec } = await bootAndDecode(
      page,
      'fixture_fill_pattern',
      '&sprite=/fixture-sprite',
    )
    console.log(
      `[gate fill_pattern] ${dec.w}x${dec.h} ready=${ready} fillDraws=${fillDraws} bg=${dec.bg} ` +
        `centre=${dec.centre} whole=${dec.whole} patternVividInterior=${dec.patternVividInterior}`,
    )
    expect(ready, 'fixture_fill_pattern never reached __xgisReady').toBe(true)
    expect(
      fillDraws,
      'no fill draw was recorded — boot/route failure, not a fill bug',
    ).toBeGreaterThan(0)
    // THE GATE: the sprite pattern fill interior must rasterise.
    expect(
      dec.patternVividInterior,
      `pattern fill interior produced ${dec.patternVividInterior} sprite px (pattern invisible under SwiftShader)`,
    ).toBeGreaterThan(3000)
  })
})
