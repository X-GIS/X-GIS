import { test, expect } from '@playwright/test'

// #834 M5 slice 4 ACCEPTANCE GATE — symbol ICONS (label-icon-image-*) render
// on the WebGL2 backend (?forcegl2=1). The fixture_symbol_icon demo's layer
// references a HOST image; the test registers a solid-magenta marker via
// map.addImage() and pushes labelled points (zero network — mirrors the
// retained-graphics gate's host-image recipe). This proves: host-atlas
// IconStage construction (spriteUrl-less #797 path) → icon dispatch beside
// the label → IconRenderer's WebGL2 bind group (atlas rhiView/rhiSampler +
// the IconDraper Material's own layout) → the icon draw on the forced
// screen pass, ordered BEFORE the text.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less.
//
// #2223 — THE ICON WITNESS IS THE MAGENTA COUNT, NOT THE WHITE ONE. This gate used
// to assert `white > 1000`, believing two solid icon quads were what pushed the white
// pixels past a text-only floor. They are not: the icon draw paints its own colour
// (the marker registered below is solid MAGENTA) and the LABEL draw that follows it
// in the same pass paints over it. Measured on this exact fixture, per GL draw call:
//
//   after the icon draw   magenta 2048 (= 2 x 32 x 32, exact)   white    0
//   after label "Alpha"   magenta 1024                          white 2486
//   after label "Beta"    magenta    0                          white 4666
//
// So every white pixel in the finished frame is a glyph, the icons are fully occluded
// by their own labels, and severing `IconDraper.draw` left the old assertion
// byte-identical and green. The marker is registered at 96x96 (not 32x32) precisely so
// the labels cannot cover it: 2 x 96 x 96 = 18432 icon pixels are painted and 13557
// survive the two label draws, which is what the assertion below counts.

/** Floor for the icon witness — see the assertion at the bottom. */
const MIN_ICON_PIXELS = 8000

test('symbol icons render on WebGl2Device (?forcegl2=1)', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.goto('/demo.html?id=fixture_symbol_icon&forcegl2=1&e2e=1', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )

  // ?e2e=1 opts out of any auto push — register the magenta marker + points.
  await page.evaluate(() => {
    const map = (
      window as unknown as {
        __xgisMap?: {
          addImage?: (name: string, image: ImageData) => void
          setSourceData?: (id: string, fc: unknown) => void
        }
      }
    ).__xgisMap
    // 96x96, not 32x32 — see the #2223 note at the top: a 32x32 marker is entirely
    // covered by its own label, so no icon pixel reaches the finished frame.
    const N = 96
    const px = new Uint8ClampedArray(N * N * 4)
    for (let i = 0; i < px.length; i += 4) {
      px[i] = 255
      px[i + 1] = 0
      px[i + 2] = 255
      px[i + 3] = 255
    }
    map?.addImage?.('e2e-marker', new ImageData(px, N, N))
    map?.setSourceData?.('pois', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 20] },
          properties: { name: 'Alpha' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [40, 0] },
          properties: { name: 'Beta' },
        },
      ],
    })
  })

  const readFrame = () =>
    page.evaluate(() => {
      const w = window as unknown as {
        __xgisActiveBackend?: string
        __xgisMap?: {
          ctx?: {
            rhi?: { backend?: string; gl?: WebGL2RenderingContext }
            _validationErrors?: { message: string }[]
          }
        }
      }
      const ctx = w.__xgisMap?.ctx
      const gl = ctx?.rhi?.gl
      if (!gl) return { ok: false as const }
      const W = gl.drawingBufferWidth
      const H = gl.drawingBufferHeight
      const buf = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      // MAGENTA = the registered marker's own colour, so these pixels can only come
      // from the icon draw sampling the host atlas (#2223). WHITE = label glyphs,
      // counted separately as a liveness check on the paired text — it is NOT an
      // icon witness (the icon draw contributes zero white pixels; measured).
      let magenta = 0
      let white = 0
      for (let p = 0; p < W * H; p++) {
        const i = p * 4
        if (buf[i] > 200 && buf[i + 1] < 60 && buf[i + 2] > 200) magenta++
        if (buf[i] > 230 && buf[i + 1] > 230 && buf[i + 2] > 230) white++
      }
      return {
        ok: true as const,
        backend: ctx?.rhi?.backend,
        marker: w.__xgisActiveBackend,
        validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
        glError: gl.getError(),
        total: W * H,
        magenta,
        white,
      }
    })

  // Converge on the quantity the assertion is ABOUT (#2223) — polling `white` let the
  // loop declare victory on a frame whose icons had never drawn.
  let r = await readFrame()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !(r.ok && r.magenta > MIN_ICON_PIXELS)) {
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    })
    await page.waitForTimeout(2000)
    r = await readFrame()
  }

  expect(r.ok, 'forced-WebGL2 context present').toBe(true)
  if (!r.ok) return
  expect(r.marker, 'window.__xgisActiveBackend').toBe('webgl2')
  expect(r.backend, 'host.ctx.rhi.backend').toBe('webgl2')
  expect(r.glError, 'no gl error').toBe(0)
  expect(r.validation, 'no validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])

  // Two 96×96 marker quads paint 18432 magenta px; the two labels cover 4875 of them,
  // leaving 13557 (measured, deterministic under SwiftShader). The floor sits well
  // below that and well above zero — severing IconDraper.draw takes it to exactly 0.
  expect(
    r.magenta,
    `magenta ICON pixels ${r.magenta}/${r.total} (floor ${MIN_ICON_PIXELS}) — the icon draw painted ${
      r.magenta === 0 ? 'NOTHING' : 'less than two marker quads'
    }`,
  ).toBeGreaterThan(MIN_ICON_PIXELS)
  // Paired-text liveness. NOT an icon witness: with the icon draw severed this count
  // is unchanged (4666, measured) — every white pixel is a label glyph.
  expect(r.white, `white LABEL pixels ${r.white}/${r.total}`).toBeGreaterThan(1000)
})
