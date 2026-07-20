import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// #1060 ACCEPTANCE GATE — the heatmap 3-pass pipeline (accum Gaussian splat →
// separable blur → density→colour compose) renders on the forced-WebGL2 twin
// (?forcegl2=1). The WebGPU path never ran on renderFrameViaRhi; this proves the
// whole RHI re-origination in one readback — RHI r16float offscreen targets with
// additive float blend, the accum GLSL twin (feat_data storage lowered to a data
// texture + texelFetch), the blur/compose GLSL twins, and offscreen→screen
// compositing through the RHI seam.
//
// CAPABILITY STANCE: this container's headless SwiftShader (ANGLE-Vulkan) DOES
// expose EXT_color_buffer_float + EXT_float_blend, so rhi.caps.floatBlendTargets
// is TRUE and the heatmap RENDERS here — hence a rendering witness (the ramp's
// saturated colours over the dark slate base) rather than a clean-gating witness.
// On a device WITHOUT those extensions the twin call site fail-closes (no draw,
// no error) — the "no page/console errors" assertion below still holds there,
// and this witness would need relaxing; that is the honest capability boundary.
//
// The heatmap demo's base map is dark slate (ocean slate-900 / land slate-800),
// so any bright, saturated pixel is heatmap ramp output (royalblue → cyan → lime
// → yellow → red). The witness counts those; the dark base counts prove the frame
// is not a black hole and the heat did not blanket it.

test('population heatmap renders on WebGl2Device (?forcegl2=1)', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.goto('/demo.html?id=heatmap&forcegl2=1&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )

  const readFrame = () =>
    page.evaluate(() => {
      const w = window as unknown as {
        __xgisActiveBackend?: string
        __xgisMap?: {
          invalidate?: () => void
          ctx?: {
            rhi?: {
              backend?: string
              gl?: WebGL2RenderingContext
              caps?: { floatBlendTargets?: boolean }
            }
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
      let heat = 0
      let base = 0
      for (let p = 0; p < W * H; p++) {
        const i = p * 4
        const r = buf[i]
        const g = buf[i + 1]
        const b = buf[i + 2]
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        // Bright + saturated → a heatmap ramp colour (the dark slate base is all
        // channels < ~60, low saturation).
        if (max > 140 && max - min > 60) heat++
        else if (max < 80) base++
      }
      return {
        ok: true as const,
        backend: ctx?.rhi?.backend,
        marker: w.__xgisActiveBackend,
        floatBlend: ctx?.rhi?.caps?.floatBlendTargets ?? false,
        validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
        glError: gl.getError(),
        W,
        H,
        total: W * H,
        heat,
        base,
      }
    })

  // Poll (invalidate + readback) until the density blobs composite — worker
  // tiling + async point upload settle at SwiftShader speed.
  let r = await readFrame()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !(r.ok && r.heat > r.total * 0.0005)) {
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    })
    await page.waitForTimeout(2000)
    r = await readFrame()
  }

  // Persist the frame for image inspection (verified: population density blobs
  // over the slate world with the blue→red ramp).
  const png = await page.locator('#map').screenshot()
  mkdirSync(join(HERE, '__render-verify__'), { recursive: true })
  writeFileSync(join(HERE, '__render-verify__', 'heatmap-gl2-gate.png'), png)

  expect(r.ok, 'forced-WebGL2 context present').toBe(true)
  if (!r.ok) return
  expect(r.marker, 'window.__xgisActiveBackend').toBe('webgl2')
  expect(r.backend, 'host.ctx.rhi.backend').toBe('webgl2')
  expect(r.glError, 'no gl error').toBe(0)
  expect(r.validation, 'no validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])

  // This container's SwiftShader exposes float-blend, so the heatmap renders.
  // (If a future runner lacks the extensions, floatBlend would be false and the
  // heat witness must relax — the no-errors assertions above still fail-closed-hold.)
  expect(r.floatBlend, 'rhi.caps.floatBlendTargets on this SwiftShader').toBe(true)

  // RENDERING WITNESS: the ramp's saturated colours cover a real (but minority)
  // share of the frame — the density composited (not a black hole) and did not
  // blanket the world (localised blobs over ~243 populated places).
  expect(r.heat, `heatmap ramp pixels ${r.heat}/${r.total}`).toBeGreaterThan(r.total * 0.0005)
  expect(r.heat, `heatmap did not blanket the frame ${r.heat}/${r.total}`).toBeLessThan(
    r.total * 0.6,
  )
  // The dark slate base survived under/around the heat — proves compositing, not
  // a full-frame overwrite.
  expect(r.base, `slate base pixels ${r.base}/${r.total}`).toBeGreaterThan(r.total * 0.1)
})
