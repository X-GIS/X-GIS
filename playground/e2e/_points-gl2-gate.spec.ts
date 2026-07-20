import { test, expect } from '@playwright/test'

// #1057 ACCEPTANCE GATE — direct-layer GeoJSON points render on the WebGL2
// backend (?forcegl2=1). pointRenderer.render had its only call site in the
// WebGPU pass-chain (points-pass.ts), and 'points' sat in pass-order.ts
// RHI_TWIN_MISSING, so the forced-WebGL2 twin (renderFrameViaRhi) drew NO
// direct-layer points. This proves the twin draw end-to-end: the point
// PointDraper Material's GLSL twin (emitPointGlsl, storage buffers lowered to
// data-texture samplers via emulateStorage), the per-layer expanded vertex /
// index / feature buffers, the shared writePointFrameUniform pack, and the new
// renderFrameViaRhi -> pointRenderer.renderRhi call site after the translucent
// bucket.
//
// Witness = a DISTINCTIVE marker colour that cannot appear vacuously. Probed:
// fixture_point does NOT exercise the direct-layer pointRenderer path on
// current main — its URL-geojson source routes through the virtual-PMTiles VT
// pipeline, so its dot draws via the VT tile-points inline path (the UNported
// follow-up half of #1057); pointRenderer.layers stays empty on BOTH backends,
// so that demo measures the wrong path and would fail with red=0 regardless of
// the port. fixture_inline_push (source tracks { type: geojson } populated via
// setSourceData) DOES route through pointRenderer.addLayer — probed under
// ?forcegl2=1: layerCount 1, expanded feat + vertex buffers built. Its layer
// paint is fill-rose-500 size-40 (rgb ~244,63,94), five dots at (-30,0),(0,0),
// (30,0),(0,30),(0,-30) over a black background — nothing else in the scene is
// red/rose. The demo-runner AUTO-PUSHES this data when the ?e2e=1 param is
// ABSENT (applyFixtureAutoPush), so the goto URL below deliberately omits it.
// On current main the twin draws no direct-layer points → zero rose pixels →
// this gate FAILS (fail-before witness); with the port it draws the five dots
// → rose pixels exceed the floor.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less, like the
// sibling _graticule-gl2-gate / _fills-gl2-gate / _lines-gl2-gate.

type MapWin = {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisMap?: {
    invalidate?: () => void
    ctx?: {
      rhi?: { backend?: string; gl?: WebGL2RenderingContext }
      _validationErrors?: { message: string }[]
    }
  }
}

test('direct-layer GeoJSON points render on WebGl2Device (?forcegl2=1)', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.setViewportSize({ width: 600, height: 600 })
  // No ?e2e=1 param — the demo-runner's applyFixtureAutoPush only fires when
  // that param is ABSENT, and the auto-push is what populates the geojson
  // source that drives pointRenderer.addLayer for fixture_inline_push.
  await page.goto('/demo.html?id=fixture_inline_push&forcegl2=1', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
    timeout: 30_000,
  })
  // No camera set: the demo boots at the demo-runner's default whole-world
  // view, and the five size-40 dots (|lon|<=30, |lat|<=30) are visible there.

  const invalidate = () =>
    page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())

  // Count rose-500-dominant pixels via a direct GL readback (no big buffer
  // crosses the CDP bridge — scalars only). A pixel counts as point fill
  // when red clearly dominates green + blue (robust to alpha-blended disc edges
  // and the exact palette value ~244,63,94).
  const readFrame = () =>
    page.evaluate(() => {
      const w = window as unknown as MapWin
      const ctx = w.__xgisMap?.ctx
      const gl = ctx?.rhi?.gl
      if (!gl) return { ok: false as const }
      const W = gl.drawingBufferWidth
      const H = gl.drawingBufferHeight
      const buf = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      let red = 0
      for (let p = 0; p < W * H; p++) {
        const i = p * 4
        const r = buf[i]
        const g = buf[i + 1]
        const b = buf[i + 2]
        if (r > 170 && g < 120 && b < 120 && r - g > 70 && r - b > 70) red++
      }
      return {
        ok: true as const,
        backend: ctx?.rhi?.backend,
        marker: w.__xgisActiveBackend,
        validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
        glError: gl.getError(),
        total: W * H,
        red,
      }
    })

  // Settle: the five rose dots must appear. Five opaque size-40 discs yield
  // plenty of rose pixels; require a conservative floor of 0.05% of the frame.
  let f = await readFrame()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !(f.ok && f.red > f.total * 0.0005)) {
    await invalidate()
    await page.waitForTimeout(1500)
    f = await readFrame()
  }

  expect(f.ok, 'forced-WebGL2 context present').toBe(true)
  if (!f.ok) return
  expect(f.marker, 'window.__xgisActiveBackend').toBe('webgl2')
  expect(f.backend, 'host.ctx.rhi.backend').toBe('webgl2')
  expect(f.glError, 'no gl error').toBe(0)
  expect(f.validation, 'no validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])

  // Fail-before witness: rose pixels only exist if the points drew. On current
  // main (twin skips points) this is 0 and the gate fails.
  expect(f.red, `rose point pixels ${f.red}/${f.total}`).toBeGreaterThan(f.total * 0.0005)

  // §5 — persist the ON frame so the pixel-count verdict can be image-inspected
  // (a scalar count is a tripwire, not a verdict).
  await page
    .locator('#xg-canv, canvas')
    .first()
    .screenshot({ path: testInfo.outputPath('points-on.png') })
})
