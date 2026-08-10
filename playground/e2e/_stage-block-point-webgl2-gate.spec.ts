// ═══ §5 render gate: the point composer seam PAINTS BOTH AXES, on real WebGL2 (#1605 Phase 3) ═══
//
// The point sibling of `_stage-block-line-webgl2-gate.spec.ts`, and it proves one thing that
// gate structurally cannot: point authors TWO independent colour axes, and this asserts they
// compose INDEPENDENTLY — point's headline property over line's single-axis seam.
//
// `fixture_stage_point_color_zoom` authors both on the same layer:
//     @color  { return vec4(zoom / 22, 0.2, 0.1, 1) }   → the disc's fill
//     @stroke { return vec4(0.1, 0.2, zoom / 22, 1) }   → the disc's outline
// Reading `zoom` makes both bodies unfoldable, so neither can be resolved on the CPU — the
// colours can only come from the composed shader evaluating each expression.
//
// WHY THIS IS NON-VACUOUS — three states are told apart, not one:
//   · both axes composed → fill ≈ (Z, 51, 26) AND stroke ≈ (26, 51, Z), on the same disc,
//                          where Z = zoom/22 · 255 at the LIVE camera zoom
//   · NOT composed       → the CPU fallback for an unfoldable stage body is the opaque-white
//                          placeholder (`STAGE_CPU_PLACEHOLDER_HEX = '#ffffffff'`,
//                          compiler/src/ir/to-property-shape.ts:53) — (255, 255, 255)
//   · ONE axis wired     → the two expected colours differ in their R and B channels (fill has
//                          the zoom value in R and 0.1 in B; stroke has them swapped), so a
//                          single colour covering the whole disc cannot satisfy both counts
// The third case is the one a naive "is it non-blank?" test would miss, and it is exactly the
// bug shape this seam risks: `variantFillColorStmts`/`variantStrokeColorStmts` fall back to the
// default feat_data read per axis, so mis-wiring one axis is silent.
//
// ═══ The zoom-derived channels TRACK THE CAMERA (#1635) ═══
//
// Until #1635 a bare `zoom` inside a stage block compiled to the literal 0.0 (`wgsl-expr.ts`'s
// Identifier arm was `featDataField(name, fieldMap) ?? f32Lit(0)`, and `zoom` is deliberately
// excluded from the collected field set), so this gate had to expect fill (0,51,26) / stroke
// (26,51,0) and say so. `zoom` is a real per-frame uniform read now (`u.zoom` — a lane point's
// group(0) block gained and `writePointFrameUniform` writes), so the gate samples at TWO camera
// zooms and requires each axis's zoom-derived channel to track `zoom / 22` at both AND to have
// moved between them. Expectations are derived from the LIVE camera at sample time, so a maxZoom
// clamp cannot green it, and the two zooms are asserted to be far enough apart that the fill and
// stroke colours stay mutually distinguishable under TOL (otherwise the classifier — and with it
// the "ONE axis wired" discrimination above — would silently degrade).
//
// Backend PINNED to WebGL2 and asserted via the live #backend-tag; `&adaptive=0` pins the
// adaptive quality controller off (same settle-race rationale as the sibling gates).

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ART = join(process.cwd(), 'test-results', 'stage-block-point-webgl2')

/** The two camera zooms sampled. Both put `zoom / 22 · 255` (≈93 and ≈162) far clear of the
 *  authored 0.1·255 ≈ 26 constant, which is what keeps the fill/stroke classifier meaningful —
 *  asserted below rather than assumed. */
const ZOOM_LO = 8
const ZOOM_HI = 14

const TOL = 14

type Win = Window & {
  __xgisReady?: boolean
  __xgisMap?: {
    project?: (p: [number, number]) => [number, number] | null
    setZoom?: (z: number) => void
    setCenter?: (lon: number, lat: number) => void
    getCamera?: () => { zoom: number }
  }
}

/** The authored expressions evaluated on the CPU at a given camera zoom. */
const expectFill = (zoom: number): [number, number, number] => [
  (zoom / 22) * 255,
  0.2 * 255,
  0.1 * 255,
]
const expectStroke = (zoom: number): [number, number, number] => [
  0.1 * 255,
  0.2 * 255,
  (zoom / 22) * 255,
]

interface RowScan {
  fillPx: number
  strokePx: number
  whitePx: number
  opaquePx: number
  /** Distinct opaque colours seen, for the failure message. */
  sample: string[]
}

/** Scan the horizontal row through the disc's centre and classify every opaque pixel against
 *  the two colours the authored expressions produce AT THIS CAMERA ZOOM. Geometry-free on
 *  purpose: the disc's exact radius (size-40) and stroke band (stroke-8) need not be computed —
 *  both authored colours must simply BE THERE, in quantity. */
async function scanRow(
  page: import('@playwright/test').Page,
  png: Buffer,
  fill: [number, number, number],
  stroke: [number, number, number],
): Promise<RowScan> {
  const centre = await page.evaluate(() => (window as unknown as Win).__xgisMap!.project!([0, 0]))
  expect(centre, 'project([0,0]) returned null — the camera is not positioned').not.toBeNull()
  return page.evaluate(
    async ({ b64, centre, fill, stroke, TOL }) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      const canvasEl = document.getElementById('map') as HTMLCanvasElement
      const scale = bmp.width / canvasEl.getBoundingClientRect().width
      const cy = Math.round(centre![1] * scale)
      const cx = Math.round(centre![0] * scale)
      const near = (v: number, e: number) => Math.abs(v - e) <= TOL
      let fillPx = 0,
        strokePx = 0,
        whitePx = 0,
        opaquePx = 0
      const seen = new Map<string, number>()
      // A generous horizontal span around the centre — wider than any plausible
      // size-40 disc, so the whole fill + both stroke bands fall inside it.
      for (let dx = -120; dx <= 120; dx++) {
        const x = cx + dx
        if (x < 0 || x >= bmp.width || cy < 0 || cy >= bmp.height) continue
        const i = (cy * bmp.width + x) * 4
        const r = d[i]!,
          g = d[i + 1]!,
          b = d[i + 2]!,
          a = d[i + 3]!
        if (a < 250) continue
        // The demo background is near-black; skip it so it can't be mistaken for
        // an authored colour's low channels.
        if (r < 20 && g < 20 && b < 20) continue
        opaquePx++
        const key = `${r},${g},${b}`
        seen.set(key, (seen.get(key) ?? 0) + 1)
        if (r > 200 && g > 200 && b > 200) whitePx++
        if (near(r, fill[0]) && near(g, fill[1]) && near(b, fill[2])) fillPx++
        else if (near(r, stroke[0]) && near(g, stroke[1]) && near(b, stroke[2])) strokePx++
      }
      const sample = [...seen.entries()]
        .sort((p, q) => q[1] - p[1])
        .slice(0, 6)
        .map(([k, n]) => `${k}×${n}`)
      return { fillPx, strokePx, whitePx, opaquePx, sample }
    },
    { b64: png.toString('base64'), centre, fill, stroke, TOL },
  )
}

/** Drive the camera to `zoom` (centred on the fixture's single point), let the scene settle,
 *  and classify against the colours the LIVE camera zoom implies — a maxZoom clamp or a
 *  rejected setZoom must not be able to masquerade as a passing sample. */
async function settleAt(
  page: import('@playwright/test').Page,
  zoom: number,
): Promise<{ scan: RowScan; zoom: number; png: Buffer }> {
  await page.evaluate((z) => {
    const m = (window as unknown as Win).__xgisMap!
    m.setCenter!(0, 0)
    m.setZoom!(z)
  }, zoom)
  const live = async () =>
    page.evaluate(() => (window as unknown as Win).__xgisMap!.getCamera!().zoom)
  let z = await live()
  // Self-stabilizing capture — the engine renders on demand, so a fixed wait is not a settle
  // criterion (an early capture on the line gate caught a still-loading frame with nothing
  // drawn at all). Poll until the classification stops changing.
  let png = await page.locator('#map').screenshot()
  let scan = await scanRow(page, png, expectFill(z), expectStroke(z))
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(500)
    const next = await page.locator('#map').screenshot()
    z = await live()
    const nextScan = await scanRow(page, next, expectFill(z), expectStroke(z))
    png = next
    const settled =
      nextScan.fillPx === scan.fillPx &&
      nextScan.strokePx === scan.strokePx &&
      nextScan.opaquePx === scan.opaquePx
    scan = nextScan
    if (settled && scan.opaquePx > 0) break
  }
  return { scan, zoom: z, png }
}

test('a point layer composes @color AND @stroke independently through the GLSL shader on WebGL2 (#1605 Phase 3)', async ({
  page,
}) => {
  test.setTimeout(240_000)
  mkdirSync(ART, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto(
    '/demo.html?id=fixture_stage_point_color_zoom&backend=webgl2&e2e=1&ptdur=0&fade=0&adaptive=0',
    { waitUntil: 'domcontentloaded' },
  )
  await expect(page.locator('#backend-tag')).toHaveText('WebGL2', { timeout: 30_000 })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 30_000,
  })

  const lo = await settleAt(page, ZOOM_LO)
  writeFileSync(join(ART, `composed-point-z${ZOOM_LO}.png`), lo.png)
  const hi = await settleAt(page, ZOOM_HI)
  writeFileSync(join(ART, `composed-point-z${ZOOM_HI}.png`), hi.png)

  const fmt = (s: typeof lo) =>
    `z=${s.zoom.toFixed(2)} fill=${s.scan.fillPx} stroke=${s.scan.strokePx} white=${s.scan.whitePx} opaque=${s.scan.opaquePx} colours=[${s.scan.sample.join(' ')}]`
  console.log(`point scan lo: ${fmt(lo)}`)
  console.log(`point scan hi: ${fmt(hi)}`)

  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])

  for (const [label, s] of [
    ['lo', lo],
    ['hi', hi],
  ] as const) {
    // The classifier only carries information while the two authored colours stay further
    // apart than the tolerance can bridge — otherwise "fill" and "stroke" pixels become the
    // same bucket and the ONE-AXIS-WIRED state stops being detectable. Assert that here so a
    // future zoom change cannot silently hollow the gate out.
    const f = expectFill(s.zoom)
    const k = expectStroke(s.zoom)
    const sep = Math.max(...f.map((v, i) => Math.abs(v - k[i]!)))
    expect(
      sep,
      `${label}: fill ≈(${f.map(Math.round)}) and stroke ≈(${k.map(Math.round)}) are not separable at TOL=${TOL} — the classifier is vacuous at this zoom`,
    ).toBeGreaterThan(2 * TOL)

    // Something was drawn at all.
    expect(
      s.scan.opaquePx,
      `${label}: nothing drawn on the centre row — ${fmt(s)}`,
    ).toBeGreaterThan(20)

    // The discriminator against the not-composed state, stated explicitly.
    expect(
      s.scan.whitePx,
      `${label}: disc is the opaque-white CPU placeholder — composer did NOT run: ${fmt(s)}`,
    ).toBe(0)

    // THE VERDICT — both authored colours present, in quantity, on the same disc, at the
    // zoom-derived values the LIVE camera implies. Each count failing alone identifies WHICH
    // axis regressed, which is the point of splitting them.
    expect(
      s.scan.fillPx,
      `${label}: @color axis did not compose — expected ≈(${f.map(Math.round)}) pixels: ${fmt(s)}`,
    ).toBeGreaterThan(8)
    expect(
      s.scan.strokePx,
      `${label}: @stroke axis did not compose — expected ≈(${k.map(Math.round)}) pixels: ${fmt(s)}`,
    ).toBeGreaterThan(4)
  }

  // …and the colours MOVED with the camera. Every assertion above is satisfied by a shader
  // that read a constant equal to one sample's value; only this arm rules that out — and it
  // needs the classification at BOTH zooms to have succeeded, which is why it sits last.
  expect(hi.zoom - lo.zoom, 'the camera did not actually change zoom').toBeGreaterThan(4)
  expect(
    expectFill(hi.zoom)[0] - expectFill(lo.zoom)[0],
    'the two sampled zooms imply the same colour — the tracking arm would be vacuous',
  ).toBeGreaterThan(50)
})
