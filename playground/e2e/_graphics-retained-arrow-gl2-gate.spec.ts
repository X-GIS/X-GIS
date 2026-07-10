import { test, expect } from '@playwright/test'

// The retained host-drawing ARROW batch (map.graphics.add type:'arrow', #824/#825) renders on
// the WebGL2 backend (?forcegl2=1). The arrow shader was WGSL-only when its branch was cut
// ("matching the retained-icon path"); the retained-icon path since grew a GLSL ES 3.00 twin
// (#823, emitIconRetainedGlsl). This gate is the arrow sibling of _graphics-retained-gl2-gate:
// it proves emitArrowRetainedGlsl (same shader-dsl module, feat/tint storage lowered to R32F
// data textures, emulateStorage) drives WebGl2Device with no gl/validation error and rasterises
// the arrow silhouette — a path that could not exist at all before the twin.
//
// A single SOLID-RED arrow is anchored at the hash camera centre pointing due EAST (getBearing
// 90, geo degrees). The shaft therefore runs rightward from canvas centre; a probe box solidly
// inside the shaft must read RED, proving: the feat_data R32F texture (two projected geo points
// → screen orientation), the tint_data array<vec4f> emulation, the pointU frame UBO (geo→clip),
// and the analytic-SDF coverage fragment — the whole WebGL2 chain at once.
//
// Headless SwiftShader renders WebGL2 fine (unlike the WebGPU pixel survey), so this gate runs
// GPU-less (CI / containers) with HEADED=0 XGIS_SOFTWARE_GPU=1.

test('a retained arrow batch renders on WebGl2Device (?forcegl2=1)', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 600 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
  })

  // Camera pinned by hash (#zoom/lat/lon); the arrow tail anchors at the SAME lon/lat, so it
  // lands at canvas centre (RTC: camera centre IS clip origin) and points east from there.
  await page.goto('/demo.html?id=minimal&forcegl2=1&e2e=1#4/20/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 20000 },
  )
  await page.waitForTimeout(300)

  await page.evaluate(() => {
    const w = window as unknown as {
      __xgisMap?: { graphics: { add(spec: unknown): unknown }; invalidate?: () => void }
    }
    const map = w.__xgisMap!
    map.graphics.add({
      type: 'arrow',
      data: [0],
      getPosition: [0, 20], // [lon, lat] = the hash camera centre (arrow tail)
      getBearing: 90, // geo degrees, 0 = north CW → 90 = due east (screen +x)
      getSize: 200, // dpr-px tail→tip; shaft ≈ x∈[0,120]px, half-width ≈ 18px
      getColor: '#ee2233', // solid saturated red — unambiguous against any basemap tone
    })
    map.invalidate?.()
  })
  await page.waitForTimeout(800)

  const r = await page.evaluate(() => {
    const w = window as unknown as {
      __xgisActiveBackend?: string
      __xgisMap?: {
        ctx?: {
          rhi?: { backend?: string; gl?: WebGL2RenderingContext }
          _validationErrors?: unknown[]
        }
      }
    }
    const ctx = w.__xgisMap?.ctx
    const gl = ctx?.rhi?.gl
    if (!gl) return { ok: false as const, reason: 'no gl' }
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    // Probe box solidly INSIDE the shaft: right of centre (east), on the centre row. GL reads
    // bottom-up but the shaft straddles the centre row symmetrically, so y-origin is immaterial.
    const S = 24
    const x0 = Math.floor(W / 2 + W * 0.06) // ~+36 dpr-px into the shaft
    const y0 = Math.floor(H / 2 - S / 2)
    const buf = new Uint8Array(S * S * 4)
    gl.readPixels(x0, y0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    let red = 0
    for (let i = 0; i < S * S; i++) {
      const rC = buf[i * 4]
      const gC = buf[i * 4 + 1]
      const bC = buf[i * 4 + 2]
      if (rC > 170 && gC < 90 && bC < 90) red++
    }
    return {
      ok: true as const,
      backendMarker: w.__xgisActiveBackend,
      rhiBackend: ctx?.rhi?.backend,
      validationErrors: (ctx?._validationErrors ?? []).length,
      glError: gl.getError(),
      red,
      box: S * S,
    }
  })

  expect(r.ok, 'forced-WebGL2 context present').toBe(true)
  if (!r.ok) return

  // The frame provably originated on WebGl2Device.
  expect(r.backendMarker, 'window.__xgisActiveBackend').toBe('webgl2')
  expect(r.rhiBackend, 'host.ctx.rhi.backend').toBe('webgl2')
  // No gl error drained, no validation errors, no page/console errors.
  expect(r.glError, 'no gl error').toBe(0)
  expect(r.validationErrors, 'no validation errors').toBe(0)
  expect(errors, 'no page/console errors').toEqual([])

  // The shaft fills the probe box — require a solid red cluster (the GLSL-twin arrow rasterised,
  // tint + SDF coverage applied). A blank frame (twin missing / mis-bound storage) reads 0.
  expect(r.red, `red shaft texels ${r.red}/${r.box}`).toBeGreaterThan(r.box * 0.5)
})
