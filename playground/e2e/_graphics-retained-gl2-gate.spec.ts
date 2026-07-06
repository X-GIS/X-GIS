import { test, expect } from '@playwright/test'

// #823 — the retained host-drawing icon batch (map.graphics.add) renders on the
// WebGL2 backend (?forcegl2=1). Before #823 the retained draper was WGSL-only, so
// this path could not exist on WebGl2Device at all; the fix adds the GLSL ES 3.00
// twin (emitIconRetainedGlsl, storage buffers lowered to R32F data textures), the
// RHI-native host sprite atlas, and the renderFrameViaRhi graphics draw.
//
// The probe icon is a WHITE 32×32 sprite tinted MAGENTA via getColor, anchored at
// the camera centre — a magenta cluster at canvas centre therefore proves the
// WHOLE chain at once: feat pack (position/UV/size lanes via the feat_data R32F
// texture), the atlas region upload (white texel + alpha), the tint path (the
// array<vec4f> storage emulation — 4 texelFetch lanes), and the pointU frame UBO
// (geo→clip on the GPU). A tint failure would read back WHITE, an atlas failure
// nothing (alpha discard) — each failure mode is distinguishable.
//
// Headless SwiftShader renders WebGL2 fine (unlike the WebGPU pixel survey), so
// this gate runs GPU-less (CI / containers) with HEADED=0 XGIS_SOFTWARE_GPU=1.

test('a retained icon batch renders on WebGl2Device (?forcegl2=1)', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 600 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    // Resource-fetch noise (sandboxed/offline runners reset external fetches) is
    // not a render fault — the render bar here is gl.getError + _validationErrors.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
  })

  // Camera pinned by hash (#zoom/lat/lon); the icon anchors at the SAME lon/lat,
  // so it must land at the canvas centre (RTC: camera centre IS clip origin).
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
      __xgisMap?: {
        addImage(name: string, image: ImageData): void
        graphics: { add(spec: unknown): unknown }
        invalidate?: () => void
      }
    }
    const map = w.__xgisMap!
    // Solid WHITE 32×32 — the tint does the colouring, so magenta on screen
    // proves the tint_data (array<vec4f>) data-texture path, not just the atlas.
    const px = new Uint8ClampedArray(32 * 32 * 4).fill(255)
    map.addImage('e2e-dot', new ImageData(px, 32, 32))
    map.graphics.add({
      type: 'icon',
      data: [0],
      getPosition: [0, 20], // [lon, lat] = the hash camera centre
      getImage: 'e2e-dot',
      getSize: 2, // 64 CSS px — a comfortably readable cluster
      getColor: '#ff00ff',
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
    // Read a 64×64 box centred on the canvas (the icon is anchored centre; GL
    // reads bottom-up but the box is symmetric about the centre).
    const S = 64
    const x0 = Math.floor(W / 2 - S / 2)
    const y0 = Math.floor(H / 2 - S / 2)
    const buf = new Uint8Array(S * S * 4)
    gl.readPixels(x0, y0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    let magenta = 0
    let white = 0
    for (let i = 0; i < S * S; i++) {
      const rC = buf[i * 4]
      const gC = buf[i * 4 + 1]
      const bC = buf[i * 4 + 2]
      if (rC > 200 && gC < 60 && bC > 200) magenta++
      else if (rC > 200 && gC > 200 && bC > 200) white++
    }
    return {
      ok: true as const,
      backendMarker: w.__xgisActiveBackend,
      rhiBackend: ctx?.rhi?.backend,
      validationErrors: (ctx?._validationErrors ?? []).length,
      glError: gl.getError(),
      magenta,
      white,
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

  // The 64 dpr-px icon fills most of the 64×64 probe box — require a solid
  // magenta cluster (tint applied), and NO white cluster (tint NOT applied).
  expect(r.magenta, `magenta texels ${r.magenta}/${r.box}`).toBeGreaterThan(r.box * 0.5)
  expect(r.white, `white (untinted) texels ${r.white}/${r.box}`).toBeLessThan(r.box * 0.05)
})
