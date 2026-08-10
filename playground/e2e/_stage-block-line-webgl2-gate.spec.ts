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
// WHY THIS IS NON-VACUOUS — it distinguishes the two states it exists to tell apart:
//   · composed      → the authored vec4's constant channels, exactly: G=0.2·255=51, B=0.1·255≈26
//   · NOT composed  → the CPU fallback for an UNFOLDABLE stage body is the opaque-white
//                     placeholder (`STAGE_CPU_PLACEHOLDER_HEX = '#ffffffff'`,
//                     compiler/src/ir/to-property-shape.ts:53) — i.e. (255, 255, 255)
// Those are maximally far apart, so a green-ish stroke is proof the composed shader ran; a
// white one is proof it did not. Reverting either half of Phase 3's wiring (the renderer gate
// in `line-renderer.ts` OR the GLSL call sites in `line-material.ts`) turns this red.
//
// ═══ KNOWN GAP, deliberately encoded: the red channel is 0, not zoom/22 ═══
//
// The fixture authors `vec4(zoom / 22, 0.2, 0.1, 1)`, but a bare `zoom` inside a stage block
// currently compiles to the literal 0.0 — `wgsl-expr.ts`'s Identifier arm is
// `featDataField(name, fieldMap) ?? f32Lit(0)` (:97-98), and `zoom` is explicitly EXCLUDED
// from the collected field set (:271, :333-338, "the camera builtin … not a field"), so the
// lookup always misses and the fallback always fires. That file's own comment says so
// outright: "the same fallback that makes a bare `zoom` silently compile to 0.0 today".
// This is pre-existing and backend-agnostic (shared IR, so WebGPU is identical) — NOT
// something Phase 3's WebGL2 wiring introduced. It does not weaken this gate: reading `zoom`
// still makes the body unfoldable, which is what routes it through the composer in the first
// place, and the constant channels still prove the composed expression evaluated.
//
// Tracked as #1635. WHEN `zoom` BECOMES A REAL UNIFORM READ, THIS GATE GOES RED AT the
// R-channel assertion, AND THAT IS CORRECT — replace the `R must be 0` arm with the
// zoom-tracking assertion it was always meant to be (sample at two zooms; assert R tracks
// zoom/22 and MOVES between them). Same convention as `_fill-data-driven-gl2-gate.spec.ts`,
// which encodes #1592's gap the same way.
//
// Backend PINNED to WebGL2 and asserted via the live #backend-tag; `&adaptive=0` pins the
// adaptive quality controller off (same settle-race rationale as the sibling gates).

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ART = join(process.cwd(), 'test-results', 'stage-block-line-webgl2')

type Win = Window & {
  __xgisReady?: boolean
  __xgisMap?: { project?: (p: [number, number]) => [number, number] | null }
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

test('a non-foldable @stroke body paints its authored colour through the composed GLSL shader on WebGL2 (#1605 Phase 3)', async ({
  page,
}) => {
  test.setTimeout(150_000)
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
    if (nextRgba.every((v, k) => Math.abs(v - rgba[k]!) < 1)) {
      rgba = nextRgba
      break
    }
    rgba = nextRgba
  }
  writeFileSync(join(ART, 'composed-stroke.png'), png)
  const [r, g, b, a] = rgba
  console.log(`sampled rgba = ${rgba.map((v) => v.toFixed(1)).join(', ')}`)

  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])

  // Something was actually drawn at the sampled pixel.
  expect(a, 'stroke not opaque — nothing drawn at the sampled pixel').toBeGreaterThan(250)

  // THE VERDICT — the composed shader's own output. Tolerance ±5/255 absorbs AA at the
  // sampled run's ends and 8-bit rounding, while staying far tighter than the ~200-count
  // gap to the not-composed white placeholder.
  expect(g, 'green channel: the authored 0.2 · 255').toBeCloseTo(51, -1)
  expect(b, 'blue channel: the authored 0.1 · 255').toBeCloseTo(26, -1)

  // The discriminator, stated explicitly rather than left implicit in the tolerances above:
  // a NOT-composed stage body paints opaque white.
  expect(
    r > 200 && g > 200 && b > 200,
    `stroke is the opaque-white CPU placeholder — the composer did NOT run (got ${rgba
      .map((v) => v.toFixed(1))
      .join(', ')})`,
  ).toBe(false)

  // The known `zoom`-compiles-to-0.0 gap (see this file's header). When that is fixed this
  // assertion goes red on purpose — replace it with the zoom-tracking assertion described there.
  expect(
    r,
    'red channel: `zoom` in a stage block still compiles to literal 0.0 (#1635, pre-existing, shared IR — see header)',
  ).toBeCloseTo(0, -1)
})
