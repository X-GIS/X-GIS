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
// ═══ The RED channel: the live camera read (#1635) ═══
//
// The fixture authors `vec4(zoom / 22, 0.2, 0.1, 1)`. Until #1635 a bare `zoom` inside a stage
// block compiled to the LITERAL 0.0 — `wgsl-expr.ts`'s Identifier arm was
// `featDataField(name, fieldMap) ?? f32Lit(0)` and `zoom` is (correctly) excluded from the
// collected field set, so the lookup could never hit and the fallback always fired. The gate
// that stood here asserted `R ≈ 0` and carried a note to replace it with the tracking form the
// moment `zoom` became real. This is that form.
//
// It is a THREE-state discriminator, which the single-zoom version could not be:
//   · zoom wired      → R ≈ round(z/22 · 255): ≈35 at z3, ≈128 at z11 — and it MOVES
//   · zoom = 0.0      → R ≈ 0 at BOTH zooms (the pre-#1635 miscompile)
//   · zoom frozen     → R equal at both zooms but non-zero (a uniform lane written ONCE at
//                       boot rather than per frame — the failure a single sample cannot see)
// The third arm is why both an absolute value AND the delta are asserted; either alone is
// satisfiable by a bug.
//
// Backend PINNED to WebGL2 and asserted via the live #backend-tag; `&adaptive=0` pins the
// adaptive quality controller off (same settle-race rationale as the sibling gates).

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ART = join(process.cwd(), 'test-results', 'stage-block-line-webgl2')

type Win = Window & {
  __xgisReady?: boolean
  __xgisMap?: {
    invalidate?: () => void
    markCameraPositioned?: () => void
    project?: (p: [number, number]) => [number, number] | null
    getCamera?: () => { zoom: number; maxZoom: number; centerX: number; centerY: number }
  }
}

/** The authored red channel at a given camera zoom: `vec4(zoom / 22, …)` · 255. */
const expectedRed = (z: number): number => (z / 22) * 255

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

/** Park the camera at (0, 0) on `z` and let the on-demand renderer settle. Same shape as
 *  `_1248-composite-size-zoom.spec.ts`'s helper — the engine renders on demand, so a fixed
 *  wait is not a settle criterion; poll until the sampled colour stops changing. */
async function settleAtZoom(
  page: import('@playwright/test').Page,
  z: number,
  tag: string,
): Promise<[number, number, number, number]> {
  await page.evaluate((zoom) => {
    const m = (window as unknown as Win).__xgisMap!
    const c = m.getCamera!()
    c.zoom = Math.max(0, Math.min(c.maxZoom, zoom))
    c.centerX = 0
    c.centerY = 0
    m.markCameraPositioned?.()
    m.invalidate?.()
  }, z)
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
  writeFileSync(join(ART, `composed-stroke-${tag}.png`), png)
  console.log(`z${z} sampled rgba = ${rgba.map((v) => v.toFixed(1)).join(', ')}`)
  return rgba
}

test('a non-foldable @stroke body paints its authored colour, and its `zoom` read tracks the camera, on WebGL2 (#1605 Phase 3, #1635)', async ({
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

  const Z_LOW = 3
  const Z_HIGH = 11
  const low = await settleAtZoom(page, Z_LOW, `z${Z_LOW}`)
  const high = await settleAtZoom(page, Z_HIGH, `z${Z_HIGH}`)

  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])

  for (const [z, rgba] of [
    [Z_LOW, low],
    [Z_HIGH, high],
  ] as const) {
    const [r, g, b, a] = rgba
    const ctx = `z${z} rgba = ${rgba.map((v) => v.toFixed(1)).join(', ')}`

    // Something was actually drawn at the sampled pixel.
    expect(a, `z${z}: stroke not opaque — nothing drawn at the sampled pixel`).toBeGreaterThan(250)

    // THE COMPOSER VERDICT — the constant channels of the authored vec4, which do not
    // depend on the camera. Tolerance ±5/255 absorbs AA at the sampled run's ends and
    // 8-bit rounding, while staying far tighter than the ~200-count gap to the
    // not-composed white placeholder.
    expect(g, `${ctx} — green channel: the authored 0.2 · 255`).toBeCloseTo(51, -1)
    expect(b, `${ctx} — blue channel: the authored 0.1 · 255`).toBeCloseTo(26, -1)

    // The discriminator against the not-composed state, stated explicitly rather than
    // left implicit in the tolerances above: a NOT-composed stage body paints opaque white.
    expect(
      r > 200 && g > 200 && b > 200,
      `stroke is the opaque-white CPU placeholder — the composer did NOT run (${ctx})`,
    ).toBe(false)

    // THE ZOOM VERDICT — the red channel IS the camera read (#1635). Pre-fix this was a
    // flat 0 at every zoom, which is ~35 counts away at z3 and ~128 away at z11.
    expect(r, `${ctx} — red channel: the authored zoom/22 · 255 at z${z}`).toBeCloseTo(
      expectedRed(z),
      -1,
    )
  }

  // …and it MOVED. An absolute match at each zoom cannot rule out a lane written once at
  // boot instead of per frame; the delta can. Expected ≈ 92 counts (128 − 35).
  expect(
    high[0] - low[0],
    `red channel did not track the camera between z${Z_LOW} and z${Z_HIGH} — the zoom lane ` +
      `is frozen, not per-frame (got ${low[0].toFixed(1)} → ${high[0].toFixed(1)})`,
  ).toBeGreaterThan(60)
})
