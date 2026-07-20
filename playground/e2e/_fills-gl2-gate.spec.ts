import { test, expect } from '@playwright/test'

// #832 M2 ACCEPTANCE GATE — vector-tile polygon FILLS render on the WebGL2
// backend (?forcegl2=1). The `minimal` demo's ne_110m country polygons
// (fill-stone-200 = #e7e5e4) must appear over the analytic raster checker:
// this proves the whole M2 chain in one readback — tile selection, RHI tile
// upload (GPUArena), the polygon GLSL twin (integer uvec attributes +
// std140 Uniforms UBO), the RHI uniform ring with per-draw dynamic offsets,
// the DSFUN per-tile anchor pack, and executeItems on WebGl2Device.
//
// Headless SwiftShader renders WebGL2 (HEADED=0 XGIS_SOFTWARE_GPU=1) — this
// gate runs GPU-less, same as the sibling _graphics-retained-gl2-gate.

const _FILL: [number, number, number] = [231, 229, 228] // stone-200 country fill
const _ON: [number, number, number] = [240, 80, 40] // checker orange (ocean/underlay)
const _OFF: [number, number, number] = [30, 30, 120] // checker blue

test('ne_110m country fills render on WebGl2Device (?forcegl2=1)', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  // #1041 — the checker is opt-in now (sourceless production frames draw nothing);
  // ?debug=checker restores it so the ocean-underlay assertion below still holds.
  await page.goto('/demo.html?id=minimal&forcegl2=1&e2e=1&debug=checker', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )

  // Worker tiling + async tile upload settle at SwiftShader speed, which
  // varies a lot under parallel test load — poll (invalidate + readback)
  // until land pixels appear instead of trusting a fixed wait.
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
      const near = (i: number, c: [number, number, number], tol: number) =>
        Math.abs(buf[i] - c[0]) < tol &&
        Math.abs(buf[i + 1] - c[1]) < tol &&
        Math.abs(buf[i + 2] - c[2]) < tol
      let fill = 0
      let checker = 0
      for (let p = 0; p < W * H; p++) {
        const i = p * 4
        if (near(i, [231, 229, 228], 14)) fill++
        else if (near(i, [240, 80, 40], 70) || near(i, [30, 30, 120], 70)) checker++
      }
      return {
        ok: true as const,
        backend: ctx?.rhi?.backend,
        marker: w.__xgisActiveBackend,
        validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
        glError: gl.getError(),
        W,
        H,
        total: W * H,
        fill,
        checker,
      }
    })

  let r = await readFrame()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !(r.ok && r.fill > r.total * 0.08)) {
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

  // Land (stone-200 fills) must cover a substantial share of the world view —
  // ne_110m land is ~29% of the globe; require a conservative >8% so tile
  // pop-in variance can't flake the gate, and >0 checker (ocean) proves the
  // fills did not blanket the frame (i.e. the anchor math places them).
  expect(r.fill, `country-fill pixels ${r.fill}/${r.total}`).toBeGreaterThan(r.total * 0.08)
  expect(r.checker, `checker (ocean) pixels ${r.checker}/${r.total}`).toBeGreaterThan(r.total * 0.2)
})
