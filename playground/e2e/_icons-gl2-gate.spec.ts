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
    const px = new Uint8ClampedArray(32 * 32 * 4)
    for (let i = 0; i < px.length; i += 4) {
      px[i] = 255
      px[i + 1] = 0
      px[i + 2] = 255
      px[i + 3] = 255
    }
    map?.addImage?.('e2e-marker', new ImageData(px, 32, 32))
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
      // The symbol-icon path renders host images as MASKS (white shapes —
      // parity-verified against the WebGPU frame on this exact fixture; the
      // OFM highway-shield note documents the white-on-transparent contract),
      // so the assertion counts solid-white icon-quad pixels.
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

  let r = await readFrame()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !(r.ok && r.white > 1000)) {
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

  // Two 32×32 solid icon quads ≈ 2048 px — far above what label text alone
  // yields (~100 solid-white glyph cores, see _labels-gl2-gate), so 1000
  // requires REAL icon quads.
  expect(r.white, `white icon pixels ${r.white}/${r.total}`).toBeGreaterThan(1000)
})
