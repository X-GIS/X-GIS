import { test, expect } from '@playwright/test'

// #834 M5 slice 2 ACCEPTANCE GATE — real raster tile SOURCES render on the
// WebGL2 backend (?forcegl2=1). The fixture-raster-local demo loads the SAME
// local checker-tile.png for every visible tile (offline, deterministic),
// proving the whole chain in one readback: the SSRF-guarded fetch/decode
// (loadImageBitmap), the RHI copyExternalImage texture upload
// (texSubImage2D — no CPU readback), the RasterDraper Material draw on the
// forced screen pass, and the loop-hot pending-loads contract.
//
// SELF-CALIBRATING: the expected colours are sampled from the PNG itself in
// the page (2D-canvas decode), so a fixture-art change can't silently rot the
// gate. Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less.

test('local raster tiles render on WebGl2Device (?forcegl2=1)', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.goto('/demo.html?id=fixture_raster_local&forcegl2=1&e2e=1', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )

  // Quantized-histogram signature of the fixture PNG (it's a gradient-rich
  // test card, not a two-colour checker): top bins at 32-step quantization.
  const ref = await page.evaluate(async () => {
    const blob = await (await fetch('/checker-tile.png')).blob()
    const bmp = await createImageBitmap(blob)
    const cv = document.createElement('canvas')
    cv.width = bmp.width
    cv.height = bmp.height
    const c2 = cv.getContext('2d')!
    c2.drawImage(bmp, 0, 0)
    const d = c2.getImageData(0, 0, bmp.width, bmp.height).data
    const counts = new Map<number, number>()
    for (let i = 0; i < d.length; i += 4) {
      const k = ((d[i] >> 5) << 6) | ((d[i + 1] >> 5) << 3) | (d[i + 2] >> 5)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k]) => k)
  })
  expect(ref.length, 'fixture PNG yields a colour signature').toBeGreaterThan(4)

  const readFrame = (colors: number[]) =>
    page.evaluate((cols) => {
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
      const binCount = new Map<number, number>()
      for (let p = 0; p < W * H; p++) {
        const i = p * 4
        const k = ((buf[i] >> 5) << 6) | ((buf[i + 1] >> 5) << 3) | (buf[i + 2] >> 5)
        binCount.set(k, (binCount.get(k) ?? 0) + 1)
      }
      // A signature bin "hits" when it covers >0.3% of the frame.
      const hits = cols.map((k) => ((binCount.get(k) ?? 0) > W * H * 0.003 ? 1 : 0))
      return {
        ok: true as const,
        backend: ctx?.rhi?.backend,
        marker: w.__xgisActiveBackend,
        validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
        glError: gl.getError(),
        total: W * H,
        hits,
      }
    }, colors)

  const matched = (rr: { ok: boolean; hits?: number[] }): boolean =>
    !!rr.ok && (rr.hits ?? []).reduce((a, b) => a + b, 0) >= Math.ceil(ref.length * 0.7)
  // Poll until the raster tiles cover the view (loads settle at SwiftShader
  // speed — same polling contract as the fills/lines gates).
  let r = await readFrame(ref)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !matched(r)) {
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    })
    await page.waitForTimeout(2000)
    r = await readFrame(ref)
  }

  expect(r.ok, 'forced-WebGL2 context present').toBe(true)
  if (!r.ok) return
  expect(r.marker, 'window.__xgisActiveBackend').toBe('webgl2')
  expect(r.backend, 'host.ctx.rhi.backend').toBe('webgl2')
  expect(r.glError, 'no gl error').toBe(0)
  expect(r.validation, 'no validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])

  // ≥70% of the PNG's top-10 colour bins must be materially present in the
  // frame — the tiles cover the whole world view, so the gradient signature
  // survives quantization even with pop-in at the margins.
  const hitCount = (r.hits ?? []).reduce((a: number, b: number) => a + b, 0)
  expect(
    hitCount,
    `fixture colour-signature bins present: ${hitCount}/${ref.length}`,
  ).toBeGreaterThanOrEqual(Math.ceil(ref.length * 0.7))
})
