// ═══ §5 render gate: the line composer seam ACTUALLY PAINTS, on real WebGL2 (#1605 Phase 3) ═══
//
// This is the first automated test in the epic that proves the line `@stroke` composer seam
// puts its authored colour on screen. Its sibling `_stage-block-line-parity.spec.ts` cannot:
// that fixture's body is a CONSTANT, which `foldStageConstantRgba` resolves on the CPU, so it
// renders through the ordinary default-uniform path on either backend and never reaches the
// composer at all. Until #1605 Phase 3 the composer was WebGPU-only (both `ensureLineDraper`
// and `line-material.ts`'s GLSL call sites forced a null variant on WebGL2), and WebGPU has no
// software adapter in this sandbox (CLAUDE.md §5) — so no automated gate had ever seen the
// composed line shader paint, on any backend.
//
// WHY THIS IS NON-VACUOUS — it distinguishes the states it exists to tell apart:
//   · composed      → the authored vec4's constant channels, exactly: G=0.2·255=51, B=0.1·255≈26
//   · NOT composed  → the CPU fallback for an UNFOLDABLE stage body is the opaque-white
//                     placeholder (`STAGE_CPU_PLACEHOLDER_HEX = '#ffffffff'`,
//                     compiler/src/ir/to-property-shape.ts:53) — i.e. (255, 255, 255)
// Those are maximally far apart, so a green-ish stroke is proof the composed shader ran; a
// white one is proof it did not. Reverting either half of Phase 3's wiring (the renderer gate
// in `line-renderer.ts` OR the GLSL call sites in `line-material.ts`) turns this red.
//
// ═══ The red channel TRACKS THE CAMERA (#1635) ═══
//
// The fixture authors `vec4(zoom / 22, 0.2, 0.1, 1)`. Until #1635 a bare `zoom` inside a stage
// block compiled to the literal 0.0 — `wgsl-expr.ts`'s Identifier arm was
// `featDataField(name, fieldMap) ?? f32Lit(0)` and `zoom` is deliberately EXCLUDED from the
// collected field set (it is the camera builtin, not a feature property), so the lookup always
// missed and the fallback always fired. This gate then had to assert `R === 0` and say so.
//
// `zoom` is now a real per-frame uniform read (`u.zoom`, a named lane in the line shader's
// group(0) block that VTR already wrote), so the assertion is the one it was always meant to
// be: sample at TWO camera zooms and require R to track `zoom / 22` at each AND to have moved
// between them. That is strictly stronger than a single-zoom equality — a shader that hard-coded
// any one value, or that read a stale/constant uniform, passes the first arm and fails the
// second. R is computed FROM THE LIVE CAMERA at sample time, not from the requested zoom, so a
// maxZoom clamp cannot silently green it either.
//
// Backend PINNED to WebGL2 and asserted via the live #backend-tag; `&adaptive=0` pins the
// adaptive quality controller off (same settle-race rationale as the sibling gates).

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ART = join(process.cwd(), 'test-results', 'stage-block-line-webgl2')

/** The two camera zooms sampled. Far enough apart that the authored `zoom / 22` red channel
 *  moves ~92/255 — an order of magnitude past the ±5 tolerance, so "it moved" is unambiguous. */
const ZOOM_LO = 3
const ZOOM_HI = 11

type Win = Window & {
  __xgisReady?: boolean
  __xgisMap?: {
    project?: (p: [number, number]) => [number, number] | null
    setZoom?: (z: number) => void
    setCenter?: (lon: number, lat: number) => void
    getCamera?: () => { zoom: number }
  }
}

/** Sample the stroke at the line's midpoint (lon 0, lat 0 — the fixture's LineString spans
 *  lon -40..40 at lat 0, 16 px wide, alpha 1, so the centre row is solid, unblended colour).
 *  Averages a short horizontal run through the centre so one AA-tainted texel cannot decide
 *  the verdict. */
async function sampleStroke(
  page: import('@playwright/test').Page,
  png: Buffer,
): Promise<[number, number, number, number]> {
  const centre = await page.evaluate(() => (window as unknown as Win).__xgisMap!.project!([0, 0]))
  expect(centre, 'project([0,0]) returned null — the camera is not positioned').not.toBeNull()
  return page.evaluate(
    async ({ b64, centre }) => {
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
      const cx = Math.round(centre![0] * scale)
      const cy = Math.round(centre![1] * scale)
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0
      for (let dx = -8; dx <= 8; dx++) {
        const x = cx + dx
        if (x < 0 || x >= bmp.width || cy < 0 || cy >= bmp.height) continue
        const i = (cy * bmp.width + x) * 4
        r += d[i]!
        g += d[i + 1]!
        b += d[i + 2]!
        a += d[i + 3]!
        n++
      }
      return [r / n, g / n, b / n, a / n] as [number, number, number, number]
    },
    { b64: png.toString('base64'), centre },
  )
}

/** Drive the camera to `zoom` (centred on the line's midpoint), let the scene settle, and
 *  return the sampled stroke plus the zoom the camera ACTUALLY holds — a maxZoom clamp or a
 *  rejected setZoom must not be able to masquerade as a passing sample. */
async function settleAt(
  page: import('@playwright/test').Page,
  zoom: number,
): Promise<{ rgba: [number, number, number, number]; zoom: number; png: Buffer }> {
  await page.evaluate((z) => {
    const m = (window as unknown as Win).__xgisMap!
    m.setCenter!(0, 0)
    m.setZoom!(z)
  }, zoom)
  // Self-stabilizing capture: the engine renders on demand and the scene's tiles stream in,
  // so a fixed wait is not a settle criterion (an early capture caught a still-loading frame
  // with nothing drawn at all). Poll until the sampled stroke stops changing.
  let png = await page.locator('#map').screenshot()
  let rgba = await sampleStroke(page, png)
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(500)
    const next = await page.locator('#map').screenshot()
    const nextRgba = await sampleStroke(page, next)
    png = next
    const settled = nextRgba.every((v, k) => Math.abs(v - rgba[k]!) < 1)
    rgba = nextRgba
    if (settled) break
  }
  const live = await page.evaluate(() => (window as unknown as Win).__xgisMap!.getCamera!().zoom)
  return { rgba, zoom: live, png }
}

test('a non-foldable @stroke body paints its authored colour through the composed GLSL shader on WebGL2 (#1605 Phase 3)', async ({
  page,
}) => {
  test.setTimeout(240_000)
  mkdirSync(ART, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto(
    '/demo.html?id=fixture_stage_line_color_zoom&backend=webgl2&e2e=1&ptdur=0&fade=0&adaptive=0',
    { waitUntil: 'domcontentloaded' },
  )
  await expect(page.locator('#backend-tag')).toHaveText('WebGL2', { timeout: 30_000 })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 30_000,
  })

  const lo = await settleAt(page, ZOOM_LO)
  writeFileSync(join(ART, `composed-stroke-z${ZOOM_LO}.png`), lo.png)
  const hi = await settleAt(page, ZOOM_HI)
  writeFileSync(join(ART, `composed-stroke-z${ZOOM_HI}.png`), hi.png)

  const fmt = (s: typeof lo) => `z=${s.zoom.toFixed(2)} rgba=${s.rgba.map((v) => v.toFixed(1))}`
  console.log(`lo: ${fmt(lo)}`)
  console.log(`hi: ${fmt(hi)}`)

  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])

  for (const [label, s] of [
    ['lo', lo],
    ['hi', hi],
  ] as const) {
    const [r, g, b, a] = s.rgba

    // Something was actually drawn at the sampled pixel.
    expect(a, `${label}: stroke not opaque — nothing drawn at the sampled pixel`).toBeGreaterThan(
      250,
    )

    // THE VERDICT — the composed shader's own output. Tolerance ±5/255 absorbs AA at the
    // sampled run's ends and 8-bit rounding, while staying far tighter than the ~200-count
    // gap to the not-composed white placeholder.
    expect(g, `${label}: green channel: the authored 0.2 · 255`).toBeCloseTo(51, -1)
    expect(b, `${label}: blue channel: the authored 0.1 · 255`).toBeCloseTo(26, -1)

    // The discriminator, stated explicitly rather than left implicit in the tolerances above:
    // a NOT-composed stage body paints opaque white.
    expect(
      r > 200 && g > 200 && b > 200,
      `${label}: stroke is the opaque-white CPU placeholder — the composer did NOT run (${fmt(s)})`,
    ).toBe(false)

    // #1635 — the red channel is the authored `zoom / 22`, evaluated against the LIVE camera.
    expect(
      r,
      `${label}: red channel must be the authored zoom/22 at the live camera zoom (${fmt(s)})`,
    ).toBeCloseTo((s.zoom / 22) * 255, -1)
  }

  // …and it MOVED. A shader that read a constant (or a stale uniform never rewritten per
  // frame) satisfies every per-sample assertion above at one zoom and fails here — this is
  // the arm that distinguishes "reads the camera" from "happens to match once".
  expect(hi.zoom - lo.zoom, 'the camera did not actually change zoom').toBeGreaterThan(6)
  expect(
    hi.rgba[0] - lo.rgba[0],
    `red channel did not track the camera between zooms (${fmt(lo)} → ${fmt(hi)})`,
  ).toBeGreaterThan(50)
})
