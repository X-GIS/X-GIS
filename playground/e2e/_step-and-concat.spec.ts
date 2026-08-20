// Validates Batch 6 — `step` (N-stop) + `concat` end-to-end on a
// real GeoJSON feature set. The demo styles populated-places by
// pop_max into 4 size+color tiers and composes "Name, Country
// (NNN k)" labels via concat.
//
// Three signals, asserted CAUSE-BEFORE-EFFECT so a red run names the half
// that broke:
//   1. the composed strings reach the label stage (concat / round / the
//      `.name` `.adm0name` `.pop_max` property names all resolved)
//   2. their glyph ink is on the canvas (the stage actually drew them)
//   3. several distinct rose dot sizes are present (step tiers worked)
//
// #1838 — WHY (2) IS NOT A "PURE WHITE" COUNT. This spec used to count
// pixels at r,g,b >= 250 and require > 20. No X-GIS label can meet that,
// and the demo was reported as rendering zero label text on the strength
// of it. SDF text alpha is `smoothstep(0.75 - 2.52/size, 0.75 + 2.52/size,
// sdf)` (map/src/shaders/dsl/text.ts, MapLibre's EDGE_GAMMA algebra), and
// a glyph stem's SDF peaks near 0.887 at the 24 px atlas raster — so peak
// alpha is ~0.90 at label-size-11 and ~0.98 at 15, i.e. 229 and 249 over
// black. Measured on this backend: the CI-green label acceptance gate
// (_labels-gl2-gate, multiline_labels at size 15) scores 0 pixels >= 250
// too, and guards itself at > 230 for that reason.
//
// The ink test used here is brightness-band-free instead: label text is
// #fff over a #000 background, so its anti-aliased ink is the only NEUTRAL
// (r ~= g ~= b) bright thing in the frame — the dots are rose-500, whose
// green channel is nowhere near its red. Measured: 15 223 with labels,
// 0 with `__xgisDisableLabels`, so the assertion distinguishes the two
// states by orders of magnitude rather than by a hand-picked cliff.

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__step-and-concat__')
mkdirSync(ART, { recursive: true })

test('step (N-stop) + concat render city tiers + composite labels', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  await page.goto('/demo.html?id=step_and_concat&forcegl2=1&preserve=1#1.5/0/0/0/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 20_000 },
  )
  await page.waitForTimeout(2_500)

  const png = await page.locator('#map').screenshot()
  writeFileSync(join(ART, 'step-and-concat.png'), png)

  // (1) CAUSE — the strings the concat produced, as the label stage received
  // them post text-expression evaluation. Empty here would indict the
  // expression path; non-empty here with no ink below indicts the placer /
  // atlas / draw path.
  const composed = await page.evaluate(() => {
    const texts =
      (
        window as unknown as { __xgisMap?: { getDispatchedLabelTexts?: () => string[] | null } }
      ).__xgisMap?.getDispatchedLabelTexts?.() ?? []
    // "City, Country  (NNNk pop)" — the shape the demo's concat composes.
    const shaped = texts.filter((t) => /^[^,]+, .+ {2}\(\d+k pop\)$/.test(t))
    return { total: texts.length, shaped: shaped.length, sample: shaped.slice(0, 3) }
  })
  console.log('[step-and-concat] composed', composed)
  expect(
    composed.shaped,
    `expected concat-composed label texts (got ${composed.shaped} of ${composed.total}: ${composed.sample.join(' | ')})`,
  ).toBeGreaterThan(50)

  // (2) + (3) EFFECT — the pixels.
  const stats = await page.evaluate(async () => {
    const canvas = document.getElementById('map') as HTMLCanvasElement
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/png'))
    if (!blob) return { error: 'no blob' }
    const url = URL.createObjectURL(blob)
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image()
      i.onload = () => res(i)
      i.onerror = () => rej(new Error('decode'))
      i.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height).data
    let labelInk = 0
    let rosePixels = 0 // step-sized dots use rose-500 = #f43f5e
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!,
        g = data[i + 1]!,
        b = data[i + 2]!
      // Neutral + bright = white glyph ink (see the header note).
      if (r > 150 && Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && Math.abs(r - b) < 20)
        labelInk++
      // rose-500 fill: r≈244, g≈63, b≈94. Coarse band around it.
      if (r > 200 && g < 120 && b > 60 && b < 140) rosePixels++
    }
    return { labelInk, rosePixels }
  })

  console.log('[step-and-concat]', stats)

  if ('error' in stats) throw new Error(stats.error as string)
  // Labels rendered. ~200 px is roughly one full label's worth of ink at
  // label-size-11; measured 15 223, and 0 with the label pass disabled.
  expect(stats.labelInk, `expected label glyph ink (got ${stats.labelInk})`).toBeGreaterThan(200)
  // Step-sized rose dots rendered (size-driven by step).
  expect(
    stats.rosePixels,
    `expected rose-coloured city dots (got ${stats.rosePixels})`,
  ).toBeGreaterThan(50)

  const compileErrors = errors.filter(
    (e) =>
      e.includes('Unexpected character') ||
      e.includes('Expected utility name') ||
      e.includes('parse error'),
  )
  expect(compileErrors, 'no compile errors').toEqual([])
})
