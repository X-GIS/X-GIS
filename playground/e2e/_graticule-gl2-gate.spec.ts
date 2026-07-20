import { test, expect } from '@playwright/test'

// #1062 ACCEPTANCE GATE — the lat/lon graticule overlay renders on the WebGL2
// backend (?forcegl2=1). renderGraticuleOverlay had its only call site in the
// WebGPU pass-chain, so the forced-WebGL2 twin (renderFrameViaRhi) drew nothing
// under map.setGraticuleEnabled(true). This proves the twin draw end-to-end: the
// RHI graticule vertex buffer + UniformRing, the graticule line Material (the
// polygon module's vs_main / fs_stroke GLSL twin, LINE_FORMAT vertex layout), and
// the new 'line-list' RHI topology seam through WebGl2Device (gl.LINES).
//
// Witness = OFF-vs-ON differential (fail-before): the graticule is white @ 15%, so
// it whitens whatever it draws over. On a settled scene, the ONLY pixels that
// brighten between graticule-off and graticule-on are the grid lines. We assert
// that whitened-pixel count jumps ABOVE a floor when enabled and falls back to ~0
// when disabled again — so a twin that draws nothing (the bug) fails the gate.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less, like the sibling
// _lines-gl2-gate / _fills-gl2-gate.

type MapWin = {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __gratBaseline?: number[]
  __xgisMap?: {
    invalidate?: () => void
    setGraticuleEnabled?: (on: boolean) => void
    ctx?: {
      rhi?: { backend?: string; gl?: WebGL2RenderingContext }
      _validationErrors?: { message: string }[]
    }
  }
}

test('graticule overlay renders on WebGl2Device (?forcegl2=1)', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.goto('/demo.html?id=minimal&forcegl2=1&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
    timeout: 30_000,
  })

  const invalidate = () =>
    page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())
  const setGraticule = (on: boolean) =>
    page.evaluate((o) => (window as unknown as MapWin).__xgisMap?.setGraticuleEnabled?.(o), on)

  // Fraction of the frame occupied by the minimal demo's stone-200 country fills
  // (231,229,228) — the settle signal that the scene has converged before the
  // graticule diff is taken (so tile pop-in never contaminates the OFF baseline).
  const fillFraction = () =>
    page.evaluate(() => {
      const gl = (window as unknown as MapWin).__xgisMap?.ctx?.rhi?.gl
      if (!gl) return -1
      const W = gl.drawingBufferWidth
      const H = gl.drawingBufferHeight
      const buf = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      let fill = 0
      for (let p = 0; p < W * H; p++) {
        const i = p * 4
        if (
          Math.abs(buf[i] - 231) < 14 &&
          Math.abs(buf[i + 1] - 229) < 14 &&
          Math.abs(buf[i + 2] - 228) < 14
        )
          fill++
      }
      return fill / (W * H)
    })

  // Snapshot the current frame onto window.__gratBaseline (the OFF baseline).
  const snapshotBaseline = () =>
    page.evaluate(() => {
      const w = window as unknown as MapWin
      const gl = w.__xgisMap?.ctx?.rhi?.gl
      if (!gl) return false
      const W = gl.drawingBufferWidth
      const H = gl.drawingBufferHeight
      const buf = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      w.__gratBaseline = Array.from(buf)
      return true
    })

  // Count pixels that WHITENED vs the OFF baseline (sum of the three channel
  // deltas > 18 ≈ +6/channel) — the graticule's white @ 15% additive lines. Returns
  // scalars only (no big buffer crosses the CDP bridge).
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
      const base = w.__gratBaseline
      let whitened = 0
      if (base) {
        for (let p = 0; p < W * H; p++) {
          const i = p * 4
          const d = buf[i] - base[i] + (buf[i + 1] - base[i + 1]) + (buf[i + 2] - base[i + 2])
          if (d > 18) whitened++
        }
      }
      return {
        ok: true as const,
        backend: ctx?.rhi?.backend,
        marker: w.__xgisActiveBackend,
        validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
        glError: gl.getError(),
        total: W * H,
        whitened,
      }
    })

  // 1) Settle the scene (graticule still OFF) until the fills have converged.
  let frac = await fillFraction()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !(frac > 0.08)) {
    await invalidate()
    await page.waitForTimeout(2000)
    frac = await fillFraction()
  }
  expect(frac, `country-fill fraction ${frac} (scene converged)`).toBeGreaterThan(0.08)

  // 2) Snapshot the OFF baseline, then enable the graticule + settle.
  expect(await snapshotBaseline(), 'baseline captured').toBe(true)
  await setGraticule(true)
  let on = await readFrame()
  const onDeadline = Date.now() + 30_000
  while (Date.now() < onDeadline && !(on.ok && on.whitened > on.total * 0.0005)) {
    await invalidate()
    await page.waitForTimeout(1000)
    on = await readFrame()
  }

  expect(on.ok, 'forced-WebGL2 context present').toBe(true)
  if (!on.ok) return
  expect(on.marker, 'window.__xgisActiveBackend').toBe('webgl2')
  expect(on.backend, 'host.ctx.rhi.backend').toBe('webgl2')
  expect(on.glError, 'no gl error').toBe(0)
  expect(on.validation, 'no validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])

  // Grid lines fan meridians + parallels across the whole view — thin but plentiful.
  // Require a conservative >0.05% of the frame to have whitened once enabled.
  expect(on.whitened, `graticule-whitened pixels ${on.whitened}/${on.total}`).toBeGreaterThan(
    on.total * 0.0005,
  )

  // §5 — persist the ON frame so the pixel-count verdict can be image-inspected
  // (a scalar count is a tripwire, not a verdict).
  await page
    .locator('#xg-canv, canvas')
    .first()
    .screenshot({ path: testInfo.outputPath('graticule-on.png') })

  // 3) Fail-before witness: disable the graticule again → the whitened pixels must
  // vanish (the grid was genuinely absent when off, not incidental scene noise).
  await setGraticule(false)
  let off = await readFrame()
  const offDeadline = Date.now() + 20_000
  while (Date.now() < offDeadline && off.ok && off.whitened > on.whitened * 0.2) {
    await invalidate()
    await page.waitForTimeout(1000)
    off = await readFrame()
  }
  expect(
    off.ok && off.whitened,
    `graticule-off whitened pixels ${off.ok && off.whitened}`,
  ).toBeLessThan(on.whitened * 0.2)
})
