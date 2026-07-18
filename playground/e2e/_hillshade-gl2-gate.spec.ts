import { test, expect } from '@playwright/test'

// #777 Phase II ACCEPTANCE GATE — a raster-dem source renders as shaded relief
// on the WebGL2 backend (?forcegl2=1). The fixture_hillshade_local demo loads
// the SAME local Terrain-RGB DEM (dem-fixture.png, a radial hill) for every
// visible tile (offline, deterministic), proving the whole hillshade chain in
// one readback: the source-manager `_dem` route, the DEM texture upload, the
// HillshadeDraper Material draw (fs_hillshade GLSL twin compiled by SwiftShader),
// the HillshadePass, and the frag_depth log-depth path.
//
// SELF-CALIBRATING vs a FLAT fill: a hillshade of a radial hill produces a
// LUMINANCE SPREAD (slopes facing the 335° light are bright, slopes away are
// dark) — a blank frame or a flat colour fill would collapse to ~1 luminance
// level. The gate asserts a genuine dark→light spread over the frame, so it
// cannot pass on a non-rendering (blank) or a broken flat-shade output.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less, CI-safe.

test('local raster-dem renders as shaded relief on WebGl2Device (?forcegl2=1)', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.goto('/demo.html?id=fixture_hillshade_local&forcegl2=1&e2e=1', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
  // The demo opens at z11 (Demo.zoom) — real DEM tiles are z8–14 and the Sobel
  // deriv scale is calibrated for those; a whole-world DEM is physically
  // near-flat at low zoom. No test-only camera set: the demo's own zoom is
  // what makes the relief visible, so this gate also covers Demo.zoom.

  // Read back the forced-WebGL2 frame and compute a 16-bin luminance histogram
  // over the non-transparent pixels. Returns the backend markers + the spread
  // metrics the relief assertion needs.
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
      const bins = new Array<number>(16).fill(0)
      let lit = 0
      let minL = 255
      let maxL = 0
      for (let p = 0; p < W * H; p++) {
        const i = p * 4
        if (buf[i + 3] === 0) continue // skip fully-transparent background
        const lum = (buf[i] * 0.299 + buf[i + 1] * 0.587 + buf[i + 2] * 0.114) | 0
        bins[Math.min(15, lum >> 4)]++
        lit++
        if (lum < minL) minL = lum
        if (lum > maxL) maxL = lum
      }
      const nonEmptyBins = bins.filter((b) => b > lit * 0.002).length
      return {
        ok: true as const,
        backend: ctx?.rhi?.backend,
        marker: w.__xgisActiveBackend,
        validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
        glError: gl.getError(),
        total: W * H,
        lit,
        nonEmptyBins,
        spread: lit ? maxL - minL : 0, // luminance range across the relief
      }
    })

  // Relief renders when the frame carries lit pixels spread across ≥3 luminance
  // levels with a real luminance RANGE (dark shadowed slopes → lighter lit
  // slopes). Hillshade of a gentle hill is a DARK grayscale gradient (shadow
  // black → highlight white scaled by sin(slope)), so the gate keys on the
  // SPREAD, not on bright pixels — a blank/flat frame collapses spread → 0.
  const relief = (r: {
    ok: boolean
    lit?: number
    nonEmptyBins?: number
    spread?: number
    total?: number
  }): boolean =>
    !!r.ok &&
    (r.lit ?? 0) > (r.total ?? 1) * 0.05 &&
    (r.nonEmptyBins ?? 0) >= 3 &&
    (r.spread ?? 0) >= 24

  // Poll until the DEM tiles load + shade (SwiftShader decode speed).
  let r = await readFrame()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !relief(r)) {
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

  // The relief signature: lit pixels across ≥3 luminance levels with a real
  // dark→light range — proves the Sobel + shade ran, not a flat fill or a blank.
  expect(
    r.nonEmptyBins ?? 0,
    'luminance levels present (shading structure)',
  ).toBeGreaterThanOrEqual(3)
  expect(
    r.spread ?? 0,
    'luminance range across the relief (shadow → lit slope)',
  ).toBeGreaterThanOrEqual(24)
})
