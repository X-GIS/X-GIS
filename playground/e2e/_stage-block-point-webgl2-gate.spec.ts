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
//   · both axes composed → fill ≈ (0, 51, 26) AND stroke ≈ (26, 51, 0), on the same disc
//   · NOT composed       → the CPU fallback for an unfoldable stage body is the opaque-white
//                          placeholder (`STAGE_CPU_PLACEHOLDER_HEX = '#ffffffff'`,
//                          compiler/src/ir/to-property-shape.ts:53) — (255, 255, 255)
//   · ONE axis wired     → the two expected colours differ in their R and B channels (fill has
//                          blue and no red; stroke has red and no blue), so a single colour
//                          covering the whole disc cannot satisfy both assertions
// The third case is the one a naive "is it non-blank?" test would miss, and it is exactly the
// bug shape this seam risks: `variantFillColorStmts`/`variantStrokeColorStmts` fall back to the
// default feat_data read per axis, so mis-wiring one axis is silent.
//
// ═══ KNOWN GAP, deliberately encoded: the zoom-derived channels are 0 ═══
//
// A bare `zoom` inside a stage block compiles to the literal 0.0 (#1635) — `wgsl-expr.ts`'s
// Identifier arm is `featDataField(name, fieldMap) ?? f32Lit(0)` and `zoom` is explicitly
// excluded from the collected field set, so the lookup always misses. Pre-existing and
// backend-agnostic (shared IR), NOT introduced by Phase 3's WebGL2 wiring, and it does not
// weaken this gate: reading `zoom` is what makes the bodies unfoldable in the first place, and
// the constant channels still prove each composed expression evaluated. WHEN #1635 IS FIXED
// THIS GATE GOES RED at the zoom-derived channels, AND THAT IS CORRECT — swap in the
// zoom-tracking assertion (sample at two zooms; fill.R and stroke.B must track zoom/22 and
// move). Same convention `_fill-data-driven-gl2-gate.spec.ts` uses for #1592.
//
// Backend PINNED to WebGL2 and asserted via the live #backend-tag; `&adaptive=0` pins the
// adaptive quality controller off (same settle-race rationale as the sibling gates).

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ART = join(process.cwd(), 'test-results', 'stage-block-point-webgl2')

type Win = Window & {
  __xgisReady?: boolean
  __xgisMap?: { project?: (p: [number, number]) => [number, number] | null }
}

/** The authored expressions, evaluated on the CPU with #1635's `zoom` → 0.0. */
const EXPECT_FILL: [number, number, number] = [0, 0.2 * 255, 0.1 * 255] // (0, 51, 26)
const EXPECT_STROKE: [number, number, number] = [0.1 * 255, 0.2 * 255, 0] // (26, 51, 0)
const TOL = 14

interface RowScan {
  fillPx: number
  strokePx: number
  whitePx: number
  opaquePx: number
  /** Distinct opaque colours seen, for the failure message. */
  sample: string[]
}

/** Scan the horizontal row through the disc's centre and classify every opaque pixel.
 *  Geometry-free on purpose: the disc's exact radius (size-40) and stroke band (stroke-8)
 *  need not be computed — both authored colours must simply BE THERE, in quantity. */
async function scanRow(page: import('@playwright/test').Page, png: Buffer): Promise<RowScan> {
  const centre = await page.evaluate(() => (window as unknown as Win).__xgisMap!.project!([0, 0]))
  expect(centre, 'project([0,0]) returned null — the camera is not positioned').not.toBeNull()
  return page.evaluate(
    async ({ b64, centre, EXPECT_FILL, EXPECT_STROKE, TOL }) => {
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
        // the fill's (0, …) red channel.
        if (r < 20 && g < 20 && b < 20) continue
        opaquePx++
        const key = `${r},${g},${b}`
        seen.set(key, (seen.get(key) ?? 0) + 1)
        if (r > 200 && g > 200 && b > 200) whitePx++
        if (near(r, EXPECT_FILL[0]) && near(g, EXPECT_FILL[1]) && near(b, EXPECT_FILL[2])) fillPx++
        else if (
          near(r, EXPECT_STROKE[0]) &&
          near(g, EXPECT_STROKE[1]) &&
          near(b, EXPECT_STROKE[2])
        )
          strokePx++
      }
      const sample = [...seen.entries()]
        .sort((p, q) => q[1] - p[1])
        .slice(0, 6)
        .map(([k, n]) => `${k}×${n}`)
      return { fillPx, strokePx, whitePx, opaquePx, sample }
    },
    { b64: png.toString('base64'), centre, EXPECT_FILL, EXPECT_STROKE, TOL },
  )
}

test('a point layer composes @color AND @stroke independently through the GLSL shader on WebGL2 (#1605 Phase 3)', async ({
  page,
}) => {
  test.setTimeout(150_000)
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

  // Self-stabilizing capture — the engine renders on demand, so a fixed wait is not a settle
  // criterion (an early capture on the line gate caught a still-loading frame with nothing
  // drawn at all). Poll until the classification stops changing.
  let png = await page.locator('#map').screenshot()
  let scan = await scanRow(page, png)
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(500)
    const next = await page.locator('#map').screenshot()
    const nextScan = await scanRow(page, next)
    png = next
    const settled =
      nextScan.fillPx === scan.fillPx &&
      nextScan.strokePx === scan.strokePx &&
      nextScan.opaquePx === scan.opaquePx
    scan = nextScan
    if (settled && scan.opaquePx > 0) break
  }
  writeFileSync(join(ART, 'composed-point.png'), png)
  const ctx = `fill=${scan.fillPx} stroke=${scan.strokePx} white=${scan.whitePx} opaque=${scan.opaquePx} colours=[${scan.sample.join(' ')}]`
  console.log(`point scan: ${ctx}`)

  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])

  // Something was drawn at all.
  expect(scan.opaquePx, `nothing drawn on the centre row — ${ctx}`).toBeGreaterThan(20)

  // The discriminator against the not-composed state, stated explicitly.
  expect(
    scan.whitePx,
    `disc is the opaque-white CPU placeholder — composer did NOT run: ${ctx}`,
  ).toBe(0)

  // THE VERDICT — both authored colours present, in quantity, on the same disc. Each count
  // failing alone identifies WHICH axis regressed, which is the point of splitting them.
  expect(
    scan.fillPx,
    `@color axis did not compose — expected ≈(0,51,26) pixels: ${ctx}`,
  ).toBeGreaterThan(8)
  expect(
    scan.strokePx,
    `@stroke axis did not compose — expected ≈(26,51,0) pixels: ${ctx}`,
  ).toBeGreaterThan(4)
})
