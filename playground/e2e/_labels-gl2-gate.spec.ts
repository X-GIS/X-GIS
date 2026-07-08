import { test, expect } from '@playwright/test'

// #834 M5 slice 3 ACCEPTANCE GATE — LABELS (SDF text) render on the WebGL2
// backend (?forcegl2=1). The multiline_labels demo pushes GeoJSON city
// points in-page (zero network) and labels them white (#fff, halo #000):
// this proves the chain in one readback — glyph rasterize → GlyphAtlasGPU
// (RHI r8unorm pages + writeTexture) → label dispatch/collision (the SAME
// labelPass the WebGPU frame runs) → TextStage/TextRenderer → TextDraper
// Material (GLSL twin) on the forced screen pass.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less.

test('multiline labels render on WebGl2Device (?forcegl2=1)', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.goto('/demo.html?id=multiline_labels&forcegl2=1&e2e=1', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )

  // ?e2e=1 opts out of the demo-runner's auto data push (the test controls
  // the cadence) — push the labelled cities ourselves.
  await page.evaluate(() => {
    ;(
      window as unknown as {
        __xgisMap?: { setSourceData?: (id: string, fc: unknown) => void }
      }
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
      let white = 0
      for (let p = 0; p < W * H; p++) {
        const i = p * 4
        if (buf[i] > 230 && buf[i + 1] > 230 && buf[i + 2] > 230) white++
      }
      return {
        ok: true as const,
        backend: ctx?.rhi?.backend,
        marker: w.__xgisActiveBackend,
        validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
        glError: gl.getError(),
        total: W * H,
        white,
      }
    })

  // Poll until glyph rasterization + atlas upload settle (async PBF/local
  // glyph bake) — same polling contract as the fills/lines/raster gates.
  let r = await readFrame()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !(r.ok && r.white > 80)) {
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

  // Text glyphs are sparse: at z2 two of the three labels are in view and
  // 15px SDF glyphs anti-alias most of their area below the near-white
  // threshold — measured 111 solid-white pixels on SwiftShader. 80 is a
  // conservative floor that still requires REAL glyph cores (a blank frame
  // or halo-only smear stays near 0).
  expect(r.white, `white label pixels ${r.white}/${r.total}`).toBeGreaterThan(80)
})
