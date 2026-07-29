// ═══ Scaled-frame seam gate — the ladder's scene→screen path (#1429 INC-2 / #1046 Inc-4) ═══
//
// THE GAP THIS CLOSES. Inc-2f split the frame: past notch 2 the adaptive
// ladder shrinks the SCENE target while the canvas stays native, and the
// scene-upscale SEAM reinflates it (and owns the MSAA resolve — review
// CRITICAL-1). The scale-1 identity is pinned constructively by unit gates,
// but nothing drove a real SCALED frame end-to-end: the ladder engages only
// when the host is genuinely too slow — a wall-clock signal CI cannot fake
// deterministically. So the exact path a thermally-throttled production
// frame takes had no pixel gate.
//
// THE SEAM UNDER TEST. `?scenescale=0.72` (debug-flags.ts, the `?animt`
// URL + global-mirror convention) PINS the fork's adaptiveScale, so the
// chain allocates the scaled scene pair and runs the seam every frame.
// Asserted here:
//   • the seam pass DRAWS (__xgisSceneUpscaleDraws ≥ 1, increasing on
//     invalidate) — constructive proof the scaled pair exists, since the
//     pass throws when flags and bridges disagree; and the UNSCALED
//     reference frame draws it exactly 0 times (the constructive no-op).
//   • the frame still paints THROUGH the upscale: all three fixture_picking
//     quadrant colours present at native resolution (a seam that cleared
//     without drawing would present black).
//   • pickAt returns the SAME featureId as the unscaled frame at the same
//     client points — the pick RT is scene-sized and its coordinate derives
//     from pickTexture.width, not canvas.width (Inc-2f review MAJOR-1).
//
// Headless SwiftShader WebGPU (HEADED=0 XGIS_SOFTWARE_GPU=1) — the chain arm.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__render-verify__')

const VIEW = { width: 1200, height: 800 }

type Hit = { featureId: number; layerId: number } | null

async function boot(page: import('@playwright/test').Page, query: string): Promise<string[]> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })
  await page.setViewportSize(VIEW)
  await page.goto(`/demo.html?id=fixture_picking&e2e=1&picking=1${query}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
  // Deterministic framing (the _polygon-fill-flat-pixel-gate pattern): z2 at
  // the origin puts all three quadrants (lon −50..50, lat −20..20) on the
  // canvas-centre horizontal, immune to auto-fit drift.
  await page.evaluate(() => {
    ;(window as unknown as { __xgisMap?: { jumpTo?: (o: object) => void } }).__xgisMap?.jumpTo?.({
      center: [0, 0],
      zoom: 2,
    })
  })
  await page.waitForTimeout(2000)
  return errors
}

const readState = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __xgisActiveBackend?: string
      __xgisSceneUpscaleDraws?: number
    }
    return { marker: w.__xgisActiveBackend, seamDraws: w.__xgisSceneUpscaleDraws ?? 0 }
  })

// 19-point sweep along the canvas-centre horizontal (lat 0 crosses all three
// quadrants at the pinned z2 camera) — returns the hit per point so the scaled
// and unscaled runs compare POINT-BY-POINT.
const pickSweep = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const m = (window as { __xgisMap?: { pickAt(x: number, y: number): Promise<unknown> } })
      .__xgisMap!
    const r = (document.querySelector('#map') as HTMLCanvasElement).getBoundingClientRect()
    const out: Record<string, { featureId: number; layerId: number } | null> = {}
    for (let ix = 1; ix <= 19; ix++) {
      const x = r.left + (r.width * ix) / 20
      const y = r.top + r.height / 2
      out[`${ix}`] = (await m.pickAt(x, y)) as { featureId: number; layerId: number } | null
    }
    return out
  })

const countQuadrantColours = (png: PNG) => {
  let red = 0,
    green = 0,
    blue = 0
  for (let p = 0; p < png.width * png.height; p++) {
    const i = p * 4
    const r = png.data[i]!,
      g = png.data[i + 1]!,
      b = png.data[i + 2]!
    if (r > 180 && g < 120 && b < 120) red++
    if (g > 120 && r < 100 && g > b) green++
    if (b > 150 && r < 120 && g < 175) blue++
  }
  return { red, green, blue }
}

test('a pinned-scale frame runs the seam, paints, and picks like scale 1', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000)
  mkdirSync(OUT, { recursive: true })

  // Scaled frame (the ladder pinned at 0.72 — a real mid-ladder notch).
  const errors = await boot(page, '&scenescale=0.72')
  let scaled = await readState(page)
  // Settle: poll until the seam has drawn at least once (tile decode + first
  // scaled frame can lag under SwiftShader).
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && scaled.seamDraws < 1) {
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    })
    await page.waitForTimeout(2000)
    scaled = await readState(page)
  }
  const before = scaled.seamDraws
  await page.evaluate(() => {
    ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
  })
  await page.waitForTimeout(1500)
  scaled = await readState(page)

  const png = PNG.sync.read(await page.locator('#map').screenshot({ type: 'png' }))
  writeFileSync(join(OUT, 'scene-scale-seam-0.72.png'), PNG.sync.write(png))
  const colours = countQuadrantColours(png)
  const scaledHits = await pickSweep(page)

  // Unscaled reference on a second page: seam must NOT run; picks must agree.
  const ref = await context.newPage()
  await boot(ref, '')
  const refState = await readState(ref)
  const refHits = await pickSweep(ref)

  console.log(
    `[seam-gate] marker=${scaled.marker} seamDraws=${scaled.seamDraws} (before invalidate ${before}) ` +
      `ref.seamDraws=${refState.seamDraws} colours=${JSON.stringify(colours)} errors=${errors.length}`,
  )
  console.log(`[seam-gate] scaledHits=${JSON.stringify(scaledHits)}`)
  console.log(`[seam-gate] refHits=${JSON.stringify(refHits)}`)

  // The chain arm, not a fallback: SwiftShader must have enumerated WebGPU.
  expect(scaled.marker, 'default backend resolved to the WebGPU chain').toBe('webgpu')
  expect(errors, 'no page/console errors on the scaled frame').toEqual([])

  // The seam ran — and runs again per scaled frame.
  expect(scaled.seamDraws, 'seam pass drew on the pinned-scale frame').toBeGreaterThanOrEqual(1)
  expect(scaled.seamDraws, 'seam draws again on invalidate').toBeGreaterThan(before - 1)
  // The unscaled frame never allocates the pair — the constructive no-op.
  expect(refState.seamDraws, 'scale-1 frame must NOT run the seam').toBe(0)

  // The scene content survived the upscale: all three quadrants painted.
  expect(colours.red, `red quadrant pixels through the seam: ${colours.red}`).toBeGreaterThan(2000)
  expect(colours.green, `emerald quadrant pixels: ${colours.green}`).toBeGreaterThan(2000)
  expect(colours.blue, `blue quadrant pixels: ${colours.blue}`).toBeGreaterThan(2000)

  // Pick parity, point-by-point: wherever BOTH frames hit, the feature must be
  // IDENTICAL (the scaled pick RT converts client px in its own space). The
  // leftmost quadrant's featureId is 0, which the pick sentinel filter drops
  // (the documented _fixture-picking index-0 collision), so the coverage
  // contract is ≥2 distinct ids — parity itself is the per-point equality.
  const both = Object.keys(scaledHits).filter((k) => scaledHits[k] && refHits[k])
  const disagree = both.filter(
    (k) =>
      (scaledHits[k] as Exclude<Hit, null>).featureId !==
      (refHits[k] as Exclude<Hit, null>).featureId,
  )
  const ids = new Set(both.map((k) => (scaledHits[k] as Exclude<Hit, null>).featureId))
  expect(
    disagree,
    `points picking a DIFFERENT feature at 0.72 vs 1: ${disagree.join(' ')}`,
  ).toEqual([])
  expect(both.length, 'agreeing pick points span the quadrants').toBeGreaterThanOrEqual(6)
  expect(ids.size, 'agreeing picks cover ≥2 quadrants (index-0 sentinel)').toBeGreaterThanOrEqual(2)
})

test('labels stay native-crisp on a scaled frame (overlay-native property)', async ({ page }) => {
  // The design's second half (#1429 INC-2): the OVERLAY draws after the seam
  // at NATIVE resolution, so a scaled scene must not soften glyphs. Glyph
  // cores are the sharpest discriminator we have: `_labels-chain-gate`
  // measures 111 near-white pixels at scale 1 with an 80 floor — a label
  // pass drawn INTO the 0.72× scene and reinflated by the linear-filtered
  // seam smears those cores below the near-white threshold, so the SAME
  // floor on the pinned-scale frame asserts crisp-at-native.
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })
  await page.goto('/demo.html?id=multiline_labels&e2e=1&scenescale=0.72', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
  await page.evaluate(() => {
    ;(
      window as unknown as { __xgisMap?: { setSourceData?: (id: string, fc: unknown) => void } }
    ).__xgisMap?.setSourceData?.('cities', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-74, 40.7] },
          properties: { name: 'New York City' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [2.35, 48.85] },
          properties: { name: 'Paris Metropolitan Area' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [139.69, 35.68] },
          properties: { name: 'Tokyo Special Wards' },
        },
      ],
    })
  })

  const countWhite = (png: PNG): number => {
    let n = 0
    for (let p = 0; p < png.width * png.height; p++) {
      const i = p * 4
      if (png.data[i]! > 230 && png.data[i + 1]! > 230 && png.data[i + 2]! > 230) n++
    }
    return n
  }
  let png = PNG.sync.read(await page.locator('#map').screenshot({ type: 'png' }))
  let white = countWhite(png)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && white <= 80) {
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    })
    await page.waitForTimeout(2000)
    png = PNG.sync.read(await page.locator('#map').screenshot({ type: 'png' }))
    white = countWhite(png)
  }
  writeFileSync(join(OUT, 'scene-scale-seam-labels.png'), PNG.sync.write(png))
  const state = await readState(page)
  console.log(
    `[seam-gate labels] marker=${state.marker} seamDraws=${state.seamDraws} white=${white}`,
  )

  expect(state.marker, 'default backend resolved to the WebGPU chain').toBe('webgpu')
  expect(errors, 'no page/console errors').toEqual([])
  // The frame really was scaled — the seam ran…
  expect(state.seamDraws, 'seam drew on the scaled labelled frame').toBeGreaterThanOrEqual(1)
  // …and the glyph cores still clear the NATIVE-resolution floor.
  expect(white, `near-white glyph-core pixels ${white} at scenescale=0.72`).toBeGreaterThan(80)
})
