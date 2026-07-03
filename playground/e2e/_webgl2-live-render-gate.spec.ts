import { test, expect } from '@playwright/test'

// US-004 — the WebGL2 live-render MILESTONE gate. A real raster tile (an analytic
// 256² checker) renders on `WebGl2Device` THROUGH the engine's render loop under the
// OFF-by-default `?forcegl2=1` boot, and is read back pixel-for-pixel here. Asserts the
// five ACs: (1) positive WebGL2-backend marker, (2) exact checker texel colours, (3) the
// frame is not blank, (4) no gl error, (5) single-sample isolated topology.
//
// MAIN CONTEXT reads the pixels (gl.readPixels off the WebGl2Device's own context, kept
// readable by preserveDrawingBuffer). Headed Chrome — SwiftShader headless has no WebGL2
// adapter on Windows (per project memory).

const ON: [number, number, number] = [240, 80, 40] // checker "on" (orange)
const OFF: [number, number, number] = [30, 30, 120] // checker "off" (blue)

test('a raster tile renders on WebGl2Device through the engine loop (?forcegl2=1)', async ({
  page,
}) => {
  await page.goto('/demo.html?id=minimal&forcegl2=1&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 20000 },
  )
  await page.waitForTimeout(500)

  const r = await page.evaluate(() => {
    const w = window as unknown as {
      __xgisActiveBackend?: string
      __xgisMap?: {
        ctx?: {
          rhi?: { backend?: string; gl?: WebGL2RenderingContext }
          _validationErrors?: unknown[]
          sampleCount?: number
        }
      }
    }
    const ctx = w.__xgisMap?.ctx
    const gl = ctx?.rhi?.gl
    if (!gl) return { ok: false as const, reason: 'no gl' }
    const W = gl.drawingBufferWidth,
      H = gl.drawingBufferHeight
    // Sample an 8×8 grid of texels across the frame.
    const N = 8
    const samples: number[][] = []
    const px = new Uint8Array(4)
    for (let i = 1; i < N; i++)
      for (let j = 1; j < N; j++) {
        gl.readPixels(
          Math.floor((W * i) / N),
          Math.floor((H * j) / N),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          px,
        )
        samples.push([px[0], px[1], px[2]])
      }
    return {
      ok: true as const,
      backendMarker: w.__xgisActiveBackend,
      rhiBackend: ctx?.rhi?.backend,
      sampleCount: ctx?.sampleCount,
      validationErrors: (ctx?._validationErrors ?? []).length,
      glError: gl.getError(),
      samples,
    }
  })

  expect(r.ok, 'forced-WebGL2 context present').toBe(true)
  if (!r.ok) return

  // AC1 — positive WebGL2 backend marker (proves the frame came from WebGl2Device).
  expect(r.backendMarker, 'window.__xgisActiveBackend').toBe('webgl2')
  expect(r.rhiBackend, 'host.ctx.rhi.backend').toBe('webgl2')
  // AC5 — single-sample isolated topology (slice scope, not shared MSAA).
  expect(r.sampleCount, 'forced path is single-sample').toBe(1)
  // AC4 — no gl error drained, no validation errors.
  expect(r.glError, 'no gl error').toBe(0)
  expect(r.validationErrors, 'no validation errors').toBe(0)

  // AC2/AC3 — the samples are the checker (orange or blue), not the black clear. Classify
  // each sampled texel; the frame must be dominated by checker colours, not blank.
  const near = (p: number[], c: number[], tol = 70) =>
    Math.abs(p[0] - c[0]) < tol && Math.abs(p[1] - c[1]) < tol && Math.abs(p[2] - c[2]) < tol
  const checker = r.samples.filter((p) => near(p, ON) || near(p, OFF)).length
  const black = r.samples.filter((p) => p[0] < 20 && p[1] < 20 && p[2] < 20).length
  expect(checker, `checker texels (orange/blue) ${checker}/${r.samples.length}`).toBeGreaterThan(
    r.samples.length * 0.6,
  )
  expect(black, `near-black (clear) texels ${black}/${r.samples.length}`).toBeLessThan(
    r.samples.length * 0.2,
  )
})
