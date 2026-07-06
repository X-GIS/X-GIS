import { test, expect } from '@playwright/test'

// #834 M5 slice 1 ACCEPTANCE GATE — vector-tile STROKES render on the WebGL2
// backend (?forcegl2=1). The `minimal` demo's ne_110m country borders
// (stroke-stone-400 = #a8a29e, width 1px) must appear over the stone-200
// fills: this proves the line chain end-to-end — RHI segment-buffer upload,
// the line GLSL twin (segments/shapes/shape_segments R32F data-texture
// lowering + nested-struct LineLayer UBO), the LineLayer ring slot with
// per-draw dynamic offsets, and the instanced segment-quad draw through the
// LineDraper Material on WebGl2Device.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less like the
// sibling _fills-gl2-gate.

test('ne_110m country borders render on WebGl2Device (?forcegl2=1)', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.goto('/demo.html?id=minimal&forcegl2=1&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )

  // Poll (invalidate + readback) until stroke pixels appear — tile pop-in at
  // SwiftShader speed varies under parallel test load (same as the fills gate).
  const readFrame = () => page.evaluate(() => {
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
    const near = (i: number, c: [number, number, number], tol: number) =>
      Math.abs(buf[i] - c[0]) < tol &&
      Math.abs(buf[i + 1] - c[1]) < tol &&
      Math.abs(buf[i + 2] - c[2]) < tol
    let stroke = 0
    let fill = 0
    for (let p = 0; p < W * H; p++) {
      const i = p * 4
      // stone-400 borders; tol 12 keeps stone-200 fills (Δ≈63/side) excluded.
      if (near(i, [168, 162, 158], 12)) stroke++
      else if (near(i, [231, 229, 228], 14)) fill++
    }
    return {
      ok: true as const,
      backend: ctx?.rhi?.backend,
      marker: w.__xgisActiveBackend,
      validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
      glError: gl.getError(),
      total: W * H,
      stroke,
      fill,
    }
  })

  let r = await readFrame()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !(r.ok && r.stroke > r.total * 0.001)) {
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

  // 1px country borders trace coastlines/borders across the world view —
  // thin but plentiful: require a conservative >0.1% of the frame, and the
  // fills must still be present (the stroke pass must not clobber them).
  expect(r.stroke, `border-stroke pixels ${r.stroke}/${r.total}`).toBeGreaterThan(r.total * 0.001)
  expect(r.fill, `country-fill pixels ${r.fill}/${r.total}`).toBeGreaterThan(r.total * 0.08)
})
