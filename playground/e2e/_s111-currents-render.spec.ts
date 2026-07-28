// ═══ S-111 synthetic demo draws the OFFICIAL portrayal from the ENGINE (#1272 / #1333) ═══
//
// This spec used to be `test.fixme()`'d with the reason "this environment has no real GPU".
// That was half true and the wrong half: WebGL2 renders here under SwiftShader (it is what
// the CI render-gate leg drives); only WebGPU has no software adapter. The fixme is gone.
//
// It also used to await `__xgisCurrentsCells`, a handshake from the demo-runner's app-side
// particle overlay. That overlay is gone: the offline demo now draws the SAME way as
// `s111_live` — `| arrow` (the catalogue portrayal, generated in the engine) plus `| flow`
// (the non-catalogue motion). It previously subsampled every 33rd grid cell into hard-coded
// WHITE arrows, i.e. the OFFLINE example taught the approach #1333 was filed to replace.
//
// So what is pinned is the engine path, not an app global: the coverage is resident, the
// COMPILED-arrow batch exists (that batch is only ever produced by the `| arrow` fork on a
// coverage), and the frame is actually painted on WebGl2Device.

import { test, expect } from '@playwright/test'

function probe() {
  const w = window as unknown as {
    __xgisMap?: {
      ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } }
      graphics?: { hasRetainedBatches(): boolean }
      getCoverage(id: string): unknown
    }
  }
  const m = w.__xgisMap
  const gl = m?.ctx?.rhi?.gl
  if (!gl) return { ok: false as const, reason: 'no gl' }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  let painted = 0
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i]! > 24 || buf[i + 1]! > 24 || buf[i + 2]! > 24) painted++
  }
  return {
    ok: true as const,
    backend: m?.ctx?.rhi?.backend,
    coverage: m?.getCoverage('currents') != null,
    batches: m?.graphics?.hasRetainedBatches() === true,
    painted: painted / (W * H),
  }
}

test.describe('S-111 synthetic demo — engine portrayal (#1333)', () => {
  test('the catalogue arrow field is generated in the ENGINE and rasterises', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 900, height: 700 })
    await page.goto('/demo.html?id=s111_currents&forcegl2=1&e2e=1#8/38.1/-76.2', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      { timeout: 20000 },
    )
    await page.waitForFunction(
      () =>
        (
          window as unknown as { __xgisMap?: { getCoverage(id: string): unknown } }
        ).__xgisMap?.getCoverage('currents') != null,
      { timeout: 20000 },
    )
    await page.waitForTimeout(1200)

    const r = await page.evaluate(probe)
    expect(r.ok, 'WebGL2 context present').toBe(true)
    if (!r.ok) return
    await page.screenshot({ path: 'test-results/s111-synthetic-portrayal.png' })

    // Asserted so a silent backend fallback cannot green this.
    expect(r.backend, 'running on the WebGL2 backend').toBe('webgl2')
    expect(r.coverage, 'the S-111 coverage is resident').toBe(true)
    // The compiled-arrow batch is the engine `| arrow` fork's own product — an app-side
    // overlay could paint pixels without ever creating one, so this is what separates
    // "the standard portrayal ran" from "something drew".
    expect(r.batches, 'the engine produced a compiled-arrow batch').toBe(true)
    expect(r.painted, 'the field actually rasterises').toBeGreaterThan(0.01)
  })
})
